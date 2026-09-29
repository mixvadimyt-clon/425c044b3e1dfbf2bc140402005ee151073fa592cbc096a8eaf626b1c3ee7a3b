"""Применение скорера к результату сравнения: понизить пустых кандидатов.

Кандидат (`CANDIDATE`) с вероятностью подтверждения ниже порога модели становится
`NEGATIVE_VERIFIED`, а в `rationale` дописывается, кто и почему его понизил. Больше скорер ничего
не меняет: остальные статусы, значения и доказательства остаются как у правил. Повысить до
`CONFIRMED_VIOLATION` он не может — такого статуса нет даже в перечне результата сравнения.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from inspector_ml.contracts.events import CheckResult, CompareResult, MatrixParam
from inspector_ml.scorer.features import FeatureSpace, from_check
from inspector_ml.scorer.model import LogisticModel

#: Где лежат файлы моделей: `STORAGE_DIR/models/<model_version>.json` — рядом с кешем разбора,
#: в хранилище, которое видят и api, и ml.
MODELS_DIR = "models"


def model_path(storage_dir: Path, model_version: str) -> Path:
    return storage_dir / MODELS_DIR / f"{model_version}.json"


def apply(result: CompareResult, model: LogisticModel, params: Mapping[str, MatrixParam]) -> CompareResult:
    """Результат сравнения после скорера: понижены только кандидаты ниже порога."""
    if not result.checks:
        return result
    section_of = {code: str(param.section or "") for code, param in params.items()}
    space = FeatureSpace(model.sections)
    # Признаки берутся по именам из файла модели: модель, обученная до нового признака (например, `sbert`,
    # 28.09), применяется дальше. Признак модели, которого код не знает, — повод переобучить, а не угадывать.
    unknown = [name for name in model.features if name not in space.names]
    if unknown:
        raise ValueError(f"модель {model.model_version}: признаков {unknown} нет в коде — переобучите модель")
    columns = [space.names.index(name) for name in model.features]
    # Модель «мало данных» (29.09) оценивает только кандидатов, у которых есть отношение «факт / эталон»:
    # у марок (С0 → С1), текста с цифрой и нуля его нет, и сигнала для них у модели тоже нет.
    numeric_only = bool(model.meta.get("numeric_only"))
    defined = space.names.index("ratio_defined")

    checks: list[CheckResult] = []
    for check in result.checks:
        if check.finding_status != "CANDIDATE":
            checks.append(check)
            continue
        vector = space.vector(from_check(check), section_of)
        if numeric_only and not vector[defined]:
            checks.append(check)
            continue
        probability = model.proba([vector[i] for i in columns])
        if probability >= model.threshold:
            checks.append(check)
            continue
        note = (
            f"Скорер {model.model_version}: вероятность подтверждения инспектором {probability:.2f} "
            f"ниже порога {model.threshold:.2f}, кандидат понижен до NEGATIVE_VERIFIED."
        )
        rationale = f"{check.rationale} {note}" if check.rationale else note
        checks.append(check.model_copy(update={"finding_status": "NEGATIVE_VERIFIED", "rationale": rationale}))

    update: dict[str, object] = {"checks": checks}
    if result.versions is not None:
        update["versions"] = result.versions.model_copy(update={"model_version": model.model_version})
    return result.model_copy(update=update)
