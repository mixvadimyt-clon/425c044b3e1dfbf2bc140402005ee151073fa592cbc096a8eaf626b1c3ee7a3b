"""Привязка результата к паре совмещённых листов (``CheckResult.page_pair_key``).

Пары страниц считает cv/pairing.py и передаёт в движок отдельным списком. Если
доказательство лежит на листах, которые уже сопоставлены между собой, интерфейсу нужна ссылка на
эту пару — тогда карточка finding'а открывает совмещённые листы, а не просто две страницы.

Выбираем пару, покрывающую больше фрагментов доказательства: пара, к которой относятся обе стороны
сравнения, важнее пары, задевшей только один лист. При равенстве берём первую по порядку — порядок
задаёт cv/pairing.py, он же сортирует пары по убыванию ``match_score``.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from inspector_ml.contracts.events import EvidenceFragment, PagePairResult

Locator = tuple[str, int]


def _sides(pair: PagePairResult) -> tuple[Locator, Locator]:
    return (str(pair.left.file_id), pair.left.page), (str(pair.right.file_id), pair.right.page)


def key_for(fragments: Iterable[EvidenceFragment], page_pairs: Sequence[PagePairResult]) -> str | None:
    """``pair_key`` пары листов, на которые попало доказательство, либо ``None``."""
    if not page_pairs:
        return None
    places = {(str(f.file_id), f.page) for f in fragments if f.page is not None}
    if not places:
        return None
    best: tuple[int, str] | None = None
    for pair in page_pairs:
        covered = sum(side in places for side in _sides(pair))
        if covered and (best is None or covered > best[0]):
            best = (covered, pair.pair_key)
    return best[1] if best else None
