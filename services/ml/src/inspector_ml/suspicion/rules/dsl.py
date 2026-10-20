"""Мини-DSL для ``logical_rules``: разбор и вычисление без ``eval``.

Правила пишет администратор через API, то есть текст приходит из базы и доверять ему нельзя.
Поэтому никакого ``eval``, ``compile`` и ``ast``: свой разбор в дерево из шести узлов и вычисление
только по этому дереву. Арифметики в языке нет намеренно — она не нужна для проверок
согласованности между стадиями и только расширила бы поверхность.

Грамматика::

    выражение   := или
    или         := и ("or" и)*
    и           := не ("and" не)*
    не          := "not" не | сравнение
    сравнение   := значение (("==" | "!=" | ">" | ">=" | "<" | "<=") значение)?
    значение    := "(" выражение ")" | вызов | литерал | ссылка
    вызов       := ("exists" | "missing") "(" ссылка ")"
    ссылка      := КОД_ПАРАМЕТРА "." ("PD" | "RD" | "ID")     — например M-002.PD
    литерал     := ЧИСЛО | СТРОКА | "true" | "false"

Примеры из задачи: «элемент есть в ПД → должен быть в РД» — условие ``exists(M-055.PD)``,
ожидание ``exists(M-055.RD)``; «значение в РД равно значению в ПД» — условие
``exists(M-002.PD) and exists(M-002.RD)``, ожидание ``M-002.RD == M-002.PD``.

**Логика трёхзначная.** Кроме истины и лжи есть «неизвестно»: значения нет, или типы несравнимы.
Неизвестность распространяется по Клини (``ложь and неизвестно`` — ложь, ``истина or неизвестно`` —
истина) и никогда не превращается в вывод: гипотеза рождается, только когда условие достоверно
истинно, а ожидание достоверно ложно. На неполных данных правило молчит.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass

STAGES: tuple[str, ...] = ("PD", "RD", "ID")
FUNCTIONS: frozenset[str] = frozenset({"exists", "missing"})
KEYWORDS: frozenset[str] = frozenset({"and", "or", "not", "true", "false"}) | FUNCTIONS

UNKNOWN: None = None
"""Третье значение: данных не хватает или операнды несравнимы."""


class RuleSyntaxError(ValueError):
    """Правило написано неверно — движок его пропускает, а не падает."""


class _Missing:
    def __repr__(self) -> str:  # pragma: no cover — только для отладки
        return "MISSING"


MISSING = _Missing()
"""Значения параметра в этой стадии нет."""


@dataclass(frozen=True)
class Ref:
    """Ссылка на значение параметра в стадии: ``M-002.PD``."""

    param: str
    stage: str

    def __str__(self) -> str:
        return f"{self.param}.{self.stage}"


@dataclass(frozen=True)
class Const:
    value: float | str | bool

    def __str__(self) -> str:
        if isinstance(self.value, bool):
            return "true" if self.value else "false"
        return f"«{self.value}»" if isinstance(self.value, str) else f"{self.value:g}"


@dataclass(frozen=True)
class Call:
    name: str
    arg: Ref

    def __str__(self) -> str:
        return f"{self.name}({self.arg})"


@dataclass(frozen=True)
class Compare:
    op: str
    left: Node
    right: Node

    def __str__(self) -> str:
        return f"{self.left} {self.op} {self.right}"


@dataclass(frozen=True)
class Not:
    operand: Node

    def __str__(self) -> str:
        return f"not {self.operand}"


@dataclass(frozen=True)
class BoolOp:
    op: str
    parts: tuple[Node, ...]

    def __str__(self) -> str:
        return f" {self.op} ".join(str(p) for p in self.parts)


Node = Ref | Const | Call | Compare | Not | BoolOp
Value = float | str | bool | _Missing
Resolve = Callable[[Ref], Value]
"""Как движок отдаёт значение параметра в стадии для текущей контрольной точки."""

_TOKEN = re.compile(
    r"""\s*(?:
        (?P<op>==|!=|>=|<=|>|<)
      | (?P<paren>[()])
      | (?P<number>\d+(?:[.,]\d+)?)
      | (?P<string>"[^"]*"|'[^']*')
      | (?P<word>[A-Za-zА-Яа-яЁё_](?:[A-Za-z0-9А-Яа-яЁё_.\-]*[A-Za-z0-9А-Яа-яЁё_])?)
    )""",
    re.VERBOSE,
)


def tokenize(text: str) -> list[str]:
    tokens: list[str] = []
    pos = 0
    while pos < len(text):
        if (match := _TOKEN.match(text, pos)) is None:
            if text[pos:].strip() == "":
                break
            raise RuleSyntaxError(f"непонятный символ в позиции {pos}: «{text[pos]}»")
        tokens.append(match.group().strip())
        pos = match.end()
    return tokens


def parse(text: str) -> Node:
    """Разбор выражения правила. Бросает ``RuleSyntaxError``, если текст неверен."""
    if not (text or "").strip():
        raise RuleSyntaxError("пустое выражение")
    parser = _Parser(tokenize(text))
    node = parser.expression()
    if parser.rest():
        raise RuleSyntaxError(f"лишнее в конце выражения: «{' '.join(parser.rest())}»")
    return node


def refs(node: Node) -> set[Ref]:
    """Все ссылки на значения в выражении — по ним движок понимает, какие параметры нужны."""
    if isinstance(node, Ref):
        return {node}
    if isinstance(node, Call):
        return {node.arg}
    if isinstance(node, Compare):
        return refs(node.left) | refs(node.right)
    if isinstance(node, Not):
        return refs(node.operand)
    if isinstance(node, BoolOp):
        return set().union(*(refs(p) for p in node.parts))
    return set()


class _Parser:
    def __init__(self, tokens: list[str]) -> None:
        self.tokens = tokens
        self.pos = 0

    def rest(self) -> list[str]:
        return self.tokens[self.pos :]

    def peek(self) -> str | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def take(self) -> str:
        if (token := self.peek()) is None:
            raise RuleSyntaxError("выражение оборвалось")
        self.pos += 1
        return token

    def expect(self, token: str) -> None:
        if self.peek() != token:
            raise RuleSyntaxError(f"ожидалось «{token}», а получено «{self.peek() or 'конец'}»")
        self.pos += 1

    def expression(self) -> Node:
        return self.boolean("or", lambda: self.boolean("and", self.negation))

    def boolean(self, word: str, nested: Callable[[], Node]) -> Node:
        parts = [nested()]
        while (self.peek() or "").lower() == word:
            self.take()
            parts.append(nested())
        return parts[0] if len(parts) == 1 else BoolOp(word, tuple(parts))

    def negation(self) -> Node:
        if (self.peek() or "").lower() == "not":
            self.take()
            return Not(self.negation())
        return self.comparison()

    def comparison(self) -> Node:
        left = self.value()
        if (token := self.peek()) in {"==", "!=", ">", ">=", "<", "<="}:
            self.take()
            return Compare(str(token), left, self.value())
        return left

    def value(self) -> Node:
        token = self.take()
        if token == "(":
            node = self.expression()
            self.expect(")")
            return node
        if token[0] in "\"'":
            return Const(token[1:-1])
        if token[0].isdigit():
            return Const(float(token.replace(",", ".")))
        lowered = token.lower()
        if lowered in {"true", "false"}:
            return Const(lowered == "true")
        if lowered in FUNCTIONS:
            self.expect("(")
            inner = self.reference(self.take())
            self.expect(")")
            return Call(lowered, inner)
        if lowered in KEYWORDS:
            raise RuleSyntaxError(f"«{token}» не может быть значением")
        return self.reference(token)

    def reference(self, token: str) -> Ref:
        param, dot, stage = token.rpartition(".")
        if not dot or stage.upper() not in STAGES:
            raise RuleSyntaxError(f"ссылка «{token}» должна быть вида «M-002.PD» (стадия PD, RD или ID)")
        return Ref(param.upper(), stage.upper())


def truth(node: Node, resolve: Resolve) -> bool | None:
    """Истинность выражения: ``True``, ``False`` или ``UNKNOWN``."""
    if isinstance(node, Const) and isinstance(node.value, bool):
        return node.value
    if isinstance(node, Call):
        found = resolve(node.arg) is not MISSING
        return found if node.name == "exists" else not found
    if isinstance(node, Compare):
        return compare(node.op, value_of(node.left, resolve), value_of(node.right, resolve))
    if isinstance(node, Not):
        inner = truth(node.operand, resolve)
        return UNKNOWN if inner is UNKNOWN else not inner
    if isinstance(node, BoolOp):
        parts = [truth(p, resolve) for p in node.parts]
        if node.op == "and":
            return False if False in parts else (UNKNOWN if UNKNOWN in parts else True)
        return True if True in parts else (UNKNOWN if UNKNOWN in parts else False)
    # голая ссылка или не-булев литерал в логической позиции
    resolved = value_of(node, resolve)
    return resolved if isinstance(resolved, bool) else UNKNOWN


def value_of(node: Node, resolve: Resolve) -> Value:
    if isinstance(node, Const):
        return node.value
    if isinstance(node, Ref):
        return resolve(node)
    inner = truth(node, resolve)
    return MISSING if inner is UNKNOWN else inner


def compare(op: str, left: Value, right: Value) -> bool | None:
    """Сравнение двух значений; несравнимые типы дают UNKNOWN, а не ошибку."""
    if isinstance(left, _Missing) or isinstance(right, _Missing):
        return UNKNOWN
    if isinstance(left, bool) or isinstance(right, bool):
        return (left == right) if op == "==" else (left != right) if op == "!=" else UNKNOWN
    numbers = (_as_number(left), _as_number(right))
    if None not in numbers:
        return _compare_numbers(op, *numbers)  # type: ignore[misc]
    if isinstance(left, str) and isinstance(right, str):
        same = left.strip().casefold() == right.strip().casefold()
        return same if op == "==" else (not same) if op == "!=" else UNKNOWN
    return UNKNOWN


def _as_number(value: Value) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.replace(" ", "").replace(" ", "").replace(",", ".")
        try:
            return float(text)
        except ValueError:
            return None
    return None


def _compare_numbers(op: str, left: float, right: float) -> bool:
    if op in {"==", "!="}:
        same = math.isclose(left, right, rel_tol=1e-9, abs_tol=1e-9)
        return same if op == "==" else not same
    return {">": left > right, ">=": left >= right, "<": left < right, "<=": left <= right}[op]
