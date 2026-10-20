"""Восстановление имён файлов, испорченных кодировкой.

В ранней выборке архив распаковывали на macOS, и кириллица в именах превратилась в мусор
(`mac_cyrillic` поверх `cp866`). В текущей выгрузке организаторов имена корректны — все 416 путей
из `document_manifest.jsonl` нашлись как есть, — поэтому починка применяется только по необходимости.

Решение принимается по счёту: перекодированное имя принимается, только если в нём больше
кириллицы и меньше характерного мусора, чем в исходном. Так порча распознаётся даже когда
испорченное имя само состоит из кириллических букв (а именно так `mac_cyrillic` и ломает).
"""

from __future__ import annotations

import unicodedata

_CYRILLIC = set("абвгдеёжзийклмнопрстуфхцчшщъыьэюяАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ")
# Символы, которых в именах проектных файлов не бывает, а в mac_cyrillic-мусоре они обычны.
_GARBAGE = set("™†‡•¬±‰ƒ∞≠≤≥◊ﬂ¶§∑∏π∫ªº¿¡«»‹›„‚‰ÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü")


def _score(name: str) -> int:
    """Насколько имя похоже на нормальное русское: кириллица в плюс, мусор в двойной минус."""
    return sum(ch in _CYRILLIC for ch in name) - 2 * sum(ch in _GARBAGE for ch in name)


def _recode(name: str) -> str | None:
    try:
        return unicodedata.normalize("NFC", name).encode("mac_cyrillic").decode("cp866")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return None


def looks_broken(name: str) -> bool:
    """Станет ли имя заметно лучше после перекодировки."""
    candidate = _recode(name)
    return candidate is not None and _score(candidate) > _score(name)


def fix_name(name: str) -> str:
    """Вернуть исходное имя. Если починить не удалось, отдаём как есть."""
    candidate = _recode(name)
    if candidate is not None and _score(candidate) > _score(name):
        return candidate
    return name
