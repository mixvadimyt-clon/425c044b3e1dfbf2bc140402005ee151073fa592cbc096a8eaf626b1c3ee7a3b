# syntax=docker/dockerfile:1
# Локальная языковая модель для свободного поиска (ADR-0008): Ollama с весами Qwen3 8B внутри образа.
#   ./start.sh --gpu --llm
#   docker compose -f docker-compose.app.yml -f docker-compose.gpu.yml --profile llm up -d --build
#
# Почему Ollama, а не vLLM. ADR-0008 допускает оба: клиент ML говорит по OpenAI-совместимому протоколу
# (`POST /v1/chat/completions`), и рантайм меняется переменной LLM_BASE_URL. Ollama берём, потому что
# - образ с весами собирается и проверяется на любой машине, в том числе без карты: модель идёт на процессоре,
#   медленно, но это тот же образ, что у проверяющих на H100;
# - квантизация q4_K_M уже в реестре Ollama: 5,2 ГБ весов вместо 16 ГБ bf16 у vLLM;
# - видеопамяти берётся столько, сколько нужно модели и окну (около 8,5 ГБ из 80), а не заранее заданная доля карты.
#
# Веса скачиваются один раз при сборке и лежат в слое образа. В работе контейнер сидит во внутренней сети
# compose без выхода наружу (docker-compose.gpu.yml, сеть llm): интернета у модели нет по построению.
ARG OLLAMA_IMAGE=ollama/ollama:0.34.4
FROM ${OLLAMA_IMAGE}

# Модель меняется одной переменной (ADR-0008); тот же тег ML получает в LLM_MODEL.
ARG LLM_MODEL=qwen3:8b

# Окно и память. Ollama выделяет окно на каждый параллельный запрос: кеш ключей занимает
# OLLAMA_CONTEXT_LENGTH × OLLAMA_NUM_PARALLEL токенов. Проба на стенде 17.10: при 32k × 4 кеш у qwen3:0.6b занял 14 ГБ,
# у 8B было бы около 19 ГБ сверх весов — на карте 4–6 ГБ модель не поднялась бы вовсе.
# - OLLAMA_CONTEXT_LENGTH=20480 — запрос ML: до 12 000 символов каждой стадии (кириллица — около 3 символов на токен,
#   до 8 000 токенов на пару) и до 6 000 токенов ответа с рассуждением (llm/client.py). Умолчание Ollama 4k молча
#   обрезало бы запрос;
# - OLLAMA_NUM_PARALLEL=2 — два запроса одновременно: гипотезы свободного поиска редкие, очередь на модель короткая;
# - OLLAMA_FLASH_ATTENTION и OLLAMA_KV_CACHE_TYPE=q8_0 — кеш вдвое меньше без заметной потери качества.
#   Итого у qwen3:8b около 3 ГБ кеша и 5,2 ГБ весов, примерно 8,5 ГБ видеопамяти;
# - OLLAMA_KEEP_ALIVE=-1 — модель остаётся в памяти между задачами, а не выгружается через 5 минут простоя.
ENV LLM_MODEL=${LLM_MODEL} \
    OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_MODELS=/opt/ollama/models \
    OLLAMA_CONTEXT_LENGTH=20480 \
    OLLAMA_NUM_PARALLEL=2 \
    OLLAMA_FLASH_ATTENTION=1 \
    OLLAMA_KV_CACHE_TYPE=q8_0 \
    OLLAMA_KEEP_ALIVE=-1 \
    OLLAMA_MAX_LOADED_MODELS=1

# `ollama pull` ходит к серверу, поэтому на время сборки поднимаем его в фоне. Реестр Ollama изредка отвечает 503
# (поймано на стенде 17.10), поэтому до пяти попыток; докачка продолжается с того же места. `ollama show` в конце
# проверяет, что модель действительно в образе: без этого при обрыве сети сборка могла бы «пройти» с пустым каталогом.
RUN ollama serve >/tmp/ollama-build.log 2>&1 & \
    pid=$! \
 && for i in $(seq 1 30); do ollama list >/dev/null 2>&1 && break; sleep 1; done \
 && for attempt in 1 2 3 4 5; do ollama pull "$LLM_MODEL" && break; echo "попытка $attempt не удалась"; sleep 15; done \
 && ollama show "$LLM_MODEL" >/dev/null \
 && kill "$pid" \
 && echo "веса $LLM_MODEL в образе"

# Здоровье — сервер отвечает и модель в каталоге. В видеопамять модель грузится первым запросом.
HEALTHCHECK --interval=15s --timeout=10s --start-period=30s --retries=5 \
  CMD ollama show "$LLM_MODEL" >/dev/null || exit 1
