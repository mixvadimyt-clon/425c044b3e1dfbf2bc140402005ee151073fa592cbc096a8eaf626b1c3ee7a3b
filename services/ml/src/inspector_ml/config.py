"""Конфигурация ML-сервиса.

Все настройки читаются из переменных окружения и из файла ``.env`` в корне репозитория
(общий с api, шаблон — ``.env.example``). Относительные пути (``var/storage``) считаются
от корня репозитория, чтобы api и ml видели одни и те же файлы.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Файлы-маркеры, по которым ищется корень репозитория снизу вверх.
_ROOT_MARKERS = ("docker-compose.yml", "contracts")


def find_repo_root(start: Path | None = None) -> Path:
    """Корень репозитория: ``REPO_ROOT`` из окружения либо поиск маркеров вверх по дереву.

    Запасной вариант — ``services/ml`` на три уровня выше пакета: так путь остаётся верным
    при редактируемой установке (``uv sync``), с которой сервис и запускается.
    """
    env_root = os.environ.get("REPO_ROOT")
    if env_root:
        return Path(env_root).resolve()

    candidates: list[Path] = []
    if start is not None:
        candidates.append(Path(start).resolve())
    candidates.append(Path(__file__).resolve())
    candidates.append(Path.cwd().resolve())

    for candidate in candidates:
        for directory in (candidate, *candidate.parents):
            if all((directory / marker).exists() for marker in _ROOT_MARKERS):
                return directory

    # services/ml/src/inspector_ml/config.py → services/ml
    return Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """Настройки сервиса (имена полей совпадают с переменными окружения)."""

    model_config = SettingsConfigDict(
        env_file=str(find_repo_root() / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- сеть
    ml_host: str = "127.0.0.1"
    ml_port: int = 8000
    api_url: str = "http://localhost:3000"
    internal_token: str = ""

    # --- хранилище и кеш (общие с api; относительные пути — от корня репозитория)
    storage_dir: Path = Path("var/storage")
    cache_dir: Path = Path("var/cache")

    # --- разбор документов
    # Имена слоёв САПР (OCG) для текстовых блоков: полезно на чертежах, но дорого
    parse_read_layers: bool = False

    # --- версии, попадающие в результаты и доказательства
    #
    # PARSER_VERSION - ключ кеша разбора вместе с sha256 файла. Поднимается при любом изменении
    # разбора, которое меняет результат: иначе на стенд уедет кеш, посчитанный старым кодом,
    # и он будет отвечать вместо нового разбора.
    #
    # 0.2.0 - блоки с bbox и поворотами, качество страниц, штамп и метаданные,
    # OCR страниц без текстового слоя, таблицы по геометрии слов. До этой правки
    # версия оставалась 0.1.0 с самого каркаса, хотя разбор с тех пор менялся трижды.
    #
    # 0.3.0 - таблицы пересобираются после OCR. Раньше на странице без
    # текстового слоя таблиц не было по построению, и распознанный скан отдавал текст без единой
    # таблицы. На корпусе это 6477 страниц из 11 719 распознанных и 370 429 ячеек, которых
    # разбор не отдавал вовсе.
    #
    # 0.4.0 - страница с нечитаемым текстовым слоем уходит в распознавание. Шрифт без
    # дескриптора отдаёт кашу вместо кириллицы, но символы при этом есть, поэтому страница
    # выглядела пригодной и OCR на неё не запускался: 515 страниц из 17 344 с текстовым слоем,
    # из них 53 в ПД по разделу ИОС - там, где живут проверки эталона про отопление.
    #
    # 0.5.0 - строки OCR сшиваются на стыках плиток, а не дублируются. Граница плитки резала
    # строку, и обе половины приходили с общим куском из полосы перекрытия: «ограниченно енной»,
    # распознанного текста на 7 % больше эталона. Строки выдаются по рядам, а не по точному
    # верхнему краю. Character Accuracy по странице на 60 страницах: 0.81 -> 0.88.
    #
    # Около 26.09 версия замораживается (ADR-0007): после заморозки менять разбор можно только
    # вместе с повторным предрасчётом на GPU (6-7 часов). Эта правка меняет разбор, поэтому
    # предрасчитанный кеш версии 0.2.0 на стенде больше не подойдёт — нужен новый прогон.
    parser_version: str = "0.5.0"
    model_version: str = "rules-0.1.0"
    dataset_version: str = "none"

    # --- обработка задач
    ml_workers: int = Field(default=2, ge=1, le=32)
    ml_job_timeout_s: int = Field(default=600, ge=1)
    # process — разбор PDF в отдельных процессах (по умолчанию), thread — для тестов и отладки
    ml_executor: Literal["process", "thread"] = "process"
    # Результат задачи лежит ещё и на диске (CACHE_DIR/jobs) и переживает перезапуск ml; столько он там живёт.
    # В памяти держим не больше ml_job_memory_max готовых задач — остальные читаются с диска. Всё и так лежит на
    # диске, а результат сравнения большой: на ВМ с 8 ГБ хватает нескольких десятков.
    ml_job_ttl_s: int = Field(default=48 * 3600, ge=60)
    ml_job_memory_max: int = Field(default=50, ge=10)
    # Куда можно слать результат (reply_to): адрес API_URL и эти, через запятую («http://127.0.0.1:3000»).
    # На чужой адрес результат не уходит — остаётся в GET /v1/jobs/{message_id} (ревью п. 2).
    ml_callback_origins: str = ""

    # --- OCR: движок, рендер и пороги
    ocr_engine: Literal["paddle", "tesseract", "none"] = "paddle"
    ocr_dpi: int = 300
    # Лист A0 при 300 dpi — это 14000 пикселей по длинной стороне; ограничиваем рендер
    ocr_max_px: int = Field(default=4000, ge=1000)
    ocr_tile_px: int = Field(default=1600, ge=400)
    ocr_overlap_px: int = Field(default=160, ge=0)
    ocr_min_confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    # Мобильный детектор PaddleOCR: серверный роняет процесс (segmentation fault) на Windows
    ocr_paddle_det_model: str = "PP-OCRv5_mobile_det"
    # auto — движок сам выберет видеокарту, если стоит paddlepaddle-gpu (на GPU ~50× быстрее)
    ocr_device: Literal["auto", "cpu", "gpu"] = "auto"
    # 0 — распознавать все страницы, иначе бюджет на документ (сканы ИД бывают на 900 страниц)
    ocr_max_pages: int = Field(default=0, ge=0)

    # --- растр для CV: кеш renders/{sha256}/{dpi}/{page}.png
    # 150 dpi — компромисс выравнивания ORB: на 100 dpi у тонких линий чертежа мало особых точек,
    # выше 150 растёт только вес PNG. Подпись листа для пар просит меньше и передаёт свой dpi.
    render_dpi: int = Field(default=150, ge=20, le=600)
    render_max_px: int = Field(default=4000, ge=1000)

    # --- эмбеддинги и LLM (только локальные модели, облачные API запрещены)
    # Имя модели в кеше Hugging Face (HF_HOME) или путь к папке с весами
    embedding_model: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    # Sentence-BERT — запасной путь извлечения числовых параметров (extract/sbert.py): где правила в
    # документе молчат, значение ищется по близости подписи к названию и якорям параметра. Нужны extra
    # embeddings и веса EMBEDDING_MODEL. Выключен по умолчанию: включается после проверки на контрольном
    # комплекте. Нет пакета или весов — работают одни правила, прогон не падает.
    sbert_enabled: bool = False
    # Порог близости подписи к параметру: подобран на обучающих объектах, на отложенных 12, 17, 18 не менялся
    sbert_threshold: float = Field(default=0.9, gt=0.0, le=1.0)
    # Сколько разных подписей задача сравнения кодирует, в порядке документов запроса. Лимит детерминированный:
    # пересчёт того же комплекта даёт те же значения при любом кеше и загрузке процессора.
    # 30 тыс. — около 4 мин на шести ядрах ноутбука, на одном ядре стенда — дольше
    sbert_max_labels: int = Field(default=30_000, ge=1)
    # Аварийный бюджет Sentence-BERT на задачу, с: только чтобы не съесть таймаут задачи (ML_JOB_TIMEOUT_S).
    # Обычно раньше кончается лимит подписей; бюджет по часам делает протокол невоспроизводимым, поэтому он большой
    sbert_budget_s: float = Field(default=1800.0, gt=0.0)
    llm_enabled: bool = False
    # Изменённые числа в совпадающем тексте ПД и РД — гипотезы без модели (suspicion/number_diff).
    # Дёшево (секунды на комплект) и не зависит от матрицы; выключается, если мешает на показе.
    number_diff_enabled: bool = True
    # Листы-чертежи ПД ↔ РД ↔ ИД: совмещение растров и гипотеза VISUAL_DIFF (suspicion/visual).
    # Растр берётся из STORAGE_DIR/raw/{sha256}; подписи в областях различий читает OCR, если он есть.
    visual_diff_enabled: bool = True
    llm_base_url: str = "http://localhost:11434/v1"
    llm_model: str = "qwen3:8b"
    llm_api_key: str = "local"
    # Документы госнадзора наружу не уходят: не «стараемся не ходить наружу», а «не ходим».
    # Клиент не поднимается на нелокальном адресе, пока это не разрешено осознанно.
    llm_allow_remote: bool = False
    # Модель не имеет права задерживать прогон: не ответила за это время — гипотез просто нет
    # (ADR-0008, «деградация обязательна»). На ноутбуке с Ollama 8B отвечает за 20-40 с.
    llm_timeout_s: float = Field(default=90.0, gt=0)
    # Рассуждение Qwen3 перед ответом. На Qwen3-8B без него гипотезы заметно хуже (живой прогон 27.09:
    # с рассуждением — «Помещение 267» на нужной паре листов, без — «Помещение 800x350»), но ответ
    # в разы длиннее: на видеокарте это секунды, на процессоре — минуты. false — быстрый режим.
    llm_think: bool = True
    # Сколько текста одной стадии кладём в запрос. 12 000 символов это около 4 000 токенов
    # на стадию, то есть обе стадии с запасом влезают в окно 32k вместе с ответом.
    llm_max_chars: int = Field(default=12000, ge=1000)

    # --- MLflow: куда `inspector-ml eval … --mlflow` пишет прогоны замеров. Тот же сервер и то же
    # имя переменной, что у api: `http://mlflow:5000/mlflow` в compose. Пусто — не пишем.
    mlflow_url: str = ""

    # --- скорер кандидатов. Файлы моделей — STORAGE_DIR/models/<версия>.json. Какую модель
    # применять, говорит api в запросе сравнения (versions.model_version); SCORER_MODEL — запасной
    # вариант для локального прогона. Пусто и там, и там — работают только правила.
    scorer_model: str = ""
    # Вход в api для `inspector-ml train` (роль ML_ENGINEER): выгрузка набора и регистрация модели
    ml_api_login: str = ""
    ml_api_password: SecretStr = SecretStr("")

    # --- логирование
    log_level: str = "info"

    @field_validator("storage_dir", "cache_dir", mode="after")
    @classmethod
    def _resolve_against_repo_root(cls, value: Path) -> Path:
        return value if value.is_absolute() else (find_repo_root() / value).resolve()

    @property
    def repo_root(self) -> Path:
        return find_repo_root()

    @property
    def parsed_dir(self) -> Path:
        """Где лежат ``parsed/{sha256}/{parser_version}.json`` (их читает compare)."""
        return self.storage_dir / "parsed"

    def storage_path(self, key: str) -> Path:
        """Путь к файлу по ключу из ``S3Ref`` (``bucket = "local"`` — локальная ФС)."""
        return self.storage_dir / key


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Настройки-синглтон. Кеш сбрасывается в тестах через ``get_settings.cache_clear()``."""
    return Settings()
