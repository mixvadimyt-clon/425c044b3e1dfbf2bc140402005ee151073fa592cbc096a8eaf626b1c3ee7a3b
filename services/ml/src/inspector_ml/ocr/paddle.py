"""PaddleOCR — основной движок распознавания (кириллическая модель, Apache-2.0).

Ставится через extra `ocr` (`uv sync --extra ocr`). Веса скачиваются при первом запуске
в кеш PaddleOCR, поэтому первый вызов дольше остальных и требует сети.

Версии PaddleOCR несовместимы между собой по API: в 2.x результат — список кортежей
`[полигон, (текст, уверенность)]`, в 3.x — объект с полями `rec_texts`, `rec_scores`, `rec_polys`.
Разбираем оба варианта, чтобы не привязываться к версии.
"""

from __future__ import annotations

import os
import threading
from typing import Any

import numpy as np

from inspector_ml.logging import get_logger
from inspector_ml.ocr.base import OcrLine, PixelBox

log = get_logger(__name__)

LANG = "ru"
# Детектор берём мобильный: серверный PP-OCRv5_server_det на paddlepaddle 3.3 под Windows
# роняет процесс (segmentation fault) уже на странице A4 в 150 dpi, а мобильный работает
# и по качеству на строительных сканах не уступает.
DET_MODEL = "PP-OCRv5_mobile_det"
# Распознаватель тоже указываем явно: если задать только детектор, PaddleOCR берёт латинскую
# модель по умолчанию и читает «ГОСТ» как «ROCT» — кириллица пропадает.
REC_MODEL = "eslav_PP-OCRv5_mobile_rec"


def _box_from_polygon(polygon: Any) -> PixelBox:
    points = np.asarray(polygon, dtype=float).reshape(-1, 2)
    return (
        float(points[:, 0].min()),
        float(points[:, 1].min()),
        float(points[:, 0].max()),
        float(points[:, 1].max()),
    )


def _lines_from_v3(result: Any) -> list[OcrLine]:
    """PaddleOCR 3.x: словарь с параллельными списками текстов, уверенностей и полигонов."""
    data = result.get("res", result) if isinstance(result, dict) else getattr(result, "json", result)
    if isinstance(data, dict) and "res" in data:
        data = data["res"]
    if not isinstance(data, dict):
        return []

    texts = data.get("rec_texts")
    scores = data.get("rec_scores")
    polygons = data.get("rec_polys") or data.get("dt_polys")
    if not texts or polygons is None:
        return []

    lines = []
    for index, text in enumerate(texts):
        if not str(text).strip():
            continue
        confidence = float(scores[index]) if scores is not None and index < len(scores) else 0.0
        lines.append(OcrLine(text=str(text).strip(), bbox=_box_from_polygon(polygons[index]), confidence=confidence))
    return lines


def _lines_from_v2(result: Any) -> list[OcrLine]:
    """PaddleOCR 2.x: `[[[полигон, (текст, уверенность)], ...]]`."""
    lines = []
    pages = result if isinstance(result, list) else [result]
    for page in pages:
        for item in page or []:
            try:
                polygon, (text, confidence) = item[0], item[1]
            except (TypeError, ValueError, IndexError):
                continue
            if not str(text).strip():
                continue
            lines.append(OcrLine(text=str(text).strip(), bbox=_box_from_polygon(polygon), confidence=float(confidence)))
    return lines


def current_device(model: Any = None) -> str:
    """Устройство, на котором работает распознавание: «gpu:0», «gpu» или «cpu».

    Спрашиваем сам конвейер PaddleOCR, а не `paddle.get_device()`. Последний отдаёт
    устройство по умолчанию для процесса, и в сборке с `paddlepaddle-gpu` это всегда «gpu:0» —
    даже когда PaddleOCR создан с `device="cpu"` и честно считает на процессоре.

    Из-за этого запись `paddle_ready` на стенде сообщала «device: gpu:0», пока распознавание
    шло на процессоре со скоростью 34 с на страницу вместо 2 с, а `ensure_device` не могла
    поймать подмену: она сверяла запрошенное с тем же самым «gpu:0». Поймано 22.09 на RTX 3050.
    """
    device = getattr(getattr(model, "paddlex_pipeline", None), "device", None)
    if device:
        return str(device)

    import paddle

    return str(paddle.get_device())


def ensure_device(requested: str, resolved: str) -> None:
    """Не дать явно запрошенной видеокарте молча превратиться в процессор.

    Запасные наборы параметров в `_build` намеренно выбрасывают `device`: без этого старые
    сборки PaddleOCR вообще не поднимались. Но цена такая — при `OCR_DEVICE=gpu` первая же
    неудача уводила распознавание на процессор, и знали мы об этом только из записи уровня
    `debug`.

    На проверяющем стенде организаторов нормативы меряют **в GPU-конфигурации**,
    а страница на процессоре стоит около минуты против секунды на карте. Молчаливая подмена
    там означала бы проваленный норматив без единого признака в логе. Поэтому при явном `gpu`
    несовпадение — ошибка; при `auto` подмена осознанна, и мы её просто записываем.
    """
    if requested == "gpu" and not resolved.startswith("gpu"):
        raise RuntimeError(
            f"OCR_DEVICE=gpu, но paddle работает на «{resolved}»: запрошенная видеокарта недоступна. "
            "Проверьте, что контейнер запущен с NVIDIA Container Toolkit и карта видна из него "
            "(`nvidia-smi` внутри контейнера), либо поставьте OCR_DEVICE=auto."
        )


class PaddleEngine:
    """Обёртка над PaddleOCR. Модель создаётся при первом распознавании."""

    name = "paddle"

    def __init__(
        self,
        lang: str = LANG,
        det_model: str | None = DET_MODEL,
        rec_model: str | None = REC_MODEL,
        cpu_threads: int | None = None,
        device: str = "auto",
    ) -> None:
        self.lang = lang
        self.det_model = det_model
        self.rec_model = rec_model
        self.cpu_threads = cpu_threads or max(1, (os.cpu_count() or 4))
        # auto — пусть PaddleOCR решает сам: с paddlepaddle-gpu он возьмёт видеокарту
        self.device = device
        self._ocr: Any | None = None
        self._loading = threading.Lock()
        #: На чём paddle оказался после инициализации — «gpu:0» или «cpu».
        self.resolved_device: str | None = None

    @staticmethod
    def available() -> bool:
        from importlib.util import find_spec

        try:
            return find_spec("paddleocr") is not None
        except (ImportError, ValueError):  # pragma: no cover — зависит от окружения
            return False

    def _model(self) -> Any:
        if self._ocr is not None:
            return self._ocr

        # Движок теперь переживает задачи (`ocr.engines.build_engine` кеширует его на процесс),
        # поэтому в потоковом режиме сюда могут войти сразу несколько задач. Веса грузятся
        # десяток секунд — замок не даёт сделать эту работу дважды.
        with self._loading:
            if self._ocr is not None:
                return self._ocr
            return self._build()

    def _build(self) -> Any:
        from paddleocr import PaddleOCR

        # 3.x: ориентацию документа и «распрямление» выключаем — они дорогие, а oneDNN на
        # paddlepaddle 3.3 падает на моделях PP-OCRv5 («ConvertPirAttribute2RuntimeAttribute
        # not support»). Проверено и в Windows, и в Linux (WSL) — ошибка одна и та же,
        # поэтому enable_mkldnn=False везде
        # Ориентация строк (`PP-LCNet_x1_0_textline_ori`) выключена, и это не про скорость.
        # Она переворачивала строки в мусор: вместо «ООО "АПСАЙД ИНЖИНИРИНГ", ОГРН 1167746504540…»
        # выходило «O . OOO () п - o) )». Замер на трёх сканах (12 страниц, 300 dpi), с ней → без неё:
        #
        #   акт ИД F0008    символов 7655 → 12913, уверенность 0.821 → 0.880
        #   акт ИД F0014    символов 7605 → 13074, уверенность 0.822 → 0.921
        #   scan-sample     символов 7161 →  9258, уверенность 0.864 → 0.965
        #
        # То есть с ней терялась почти половина текста страницы. Наши страницы и так приходят
        # повёрнутыми по `/Rotate` из PyMuPDF, разворачивать строки повторно нечего.
        # Попутно она стоила 4.4 с при подъёме движка (5.1 с против 0.7 с) и тянула третью
        # модель, из-за чего сборка GPU-образа зависела от ещё одного внешнего источника весов.
        modern = {
            "lang": self.lang,
            "use_doc_orientation_classify": False,
            "use_doc_unwarping": False,
            "use_textline_orientation": False,
            "enable_mkldnn": False,
        }
        if self.det_model:
            modern["text_detection_model_name"] = self.det_model
        if self.rec_model:
            modern["text_recognition_model_name"] = self.rec_model
        modern["cpu_threads"] = self.cpu_threads
        if self.device != "auto":
            modern["device"] = self.device

        for kwargs in (
            modern,
            {k: v for k, v in modern.items() if k != "device"},
            {k: v for k, v in modern.items() if not k.startswith("text_") and k != "device"},
            {"lang": self.lang, "use_doc_orientation_classify": False, "use_doc_unwarping": False},
            {"lang": self.lang, "use_angle_cls": True},  # 2.x
            {"lang": self.lang},
        ):
            try:
                self._ocr = PaddleOCR(**kwargs)
                self.resolved_device = current_device(self._ocr)
                ensure_device(self.device, self.resolved_device)
                log.info(
                    "paddle_ready",
                    lang=self.lang,
                    requested=self.device,
                    device=self.resolved_device,
                    options=sorted(kwargs),
                )
                return self._ocr
            except (TypeError, ValueError) as exc:
                log.debug("paddle_init_retry", options=sorted(kwargs), reason=str(exc))
        raise RuntimeError("Не удалось создать PaddleOCR ни с одним набором параметров")

    def recognize(self, image: np.ndarray) -> list[OcrLine]:
        model = self._model()
        # PaddleOCR ждёт трёхканальное изображение: на сером массиве он падает
        # с «not enough values to unpack (expected 3, got 2)»
        if image.ndim == 2:
            image = np.stack([image] * 3, axis=-1)

        predict = getattr(model, "predict", None)
        if callable(predict):
            try:
                results = predict(image)
            except (TypeError, ValueError) as exc:  # pragma: no cover — зависит от версии
                log.debug("paddle_predict_failed", reason=str(exc))
            else:
                lines: list[OcrLine] = []
                for result in results or []:
                    lines.extend(_lines_from_v3(result))
                if lines:
                    return lines

        try:
            raw = model.ocr(image)
        except TypeError:  # pragma: no cover — в 2.x нужен явный cls
            raw = model.ocr(image, cls=True)
        return _lines_from_v3(raw) if isinstance(raw, dict) else _lines_from_v2(raw)
