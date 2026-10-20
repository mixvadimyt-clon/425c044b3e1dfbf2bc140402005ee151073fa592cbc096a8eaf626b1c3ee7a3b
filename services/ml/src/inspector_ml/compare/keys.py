"""Ключи результатов — те же формулы, что в заглушке api (services/api/src/modules/transport/stub.ts)."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable


def finding_key(object_id: object, param_code: str, rule_key: str | None) -> str:
    """Ключ атомарной контрольной точки: sha1(object_id|param_code|rule_key). Он же finding_id в выгрузке GOLD."""
    return hashlib.sha1(f"{object_id}|{param_code}|{rule_key or ''}".encode()).hexdigest()


def suspicion_key(object_id: object, rule_id: object, rule_key: str | None) -> str:
    """Ключ гипотезы: sha1(object_id|rule_id|rule_key). Стабилен между версиями протокола,
    поэтому решение инспектора по гипотезе переживает пересчёт."""
    return hashlib.sha1(f"{object_id}|{rule_id}|{rule_key or ''}".encode()).hexdigest()


def manifest_hash(sha256s: Iterable[str]) -> str:
    """SHA-256 от отсортированного списка sha256 входных файлов (VersionSet.input_manifest_hash)."""
    return hashlib.sha256("\n".join(sorted(sha256s)).encode()).hexdigest()


def rule_group(rule_key: str | None) -> str | None:
    """Ключ сопоставления атомарных правил ПД ↔ РД ↔ ИД: «Помещение 1-09» и «пом. 1.09» — одна точка.

    Регистр, пробелы, «ё», сокращение «пом.» и разделитель в номере («1-09», «1,09», «1.09») не различаем.
    """
    if rule_key is None:
        return None
    text = re.sub(r"\s+", " ", rule_key).strip().casefold().replace("ё", "е")
    text = re.sub(r"\b(?:помещение|пом)\b\.?\s*(?:№\s*)?", "пом. ", text)
    text = re.sub(r"(?<=\d)\s*[-,/]\s*(?=\d)", ".", text)
    return re.sub(r"\s*([()])\s*", r" \1", text).replace(" )", ")").strip()
