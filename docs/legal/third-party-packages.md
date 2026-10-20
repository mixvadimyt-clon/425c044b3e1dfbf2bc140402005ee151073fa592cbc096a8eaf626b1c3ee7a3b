# Сторонние пакеты в образах продукта

> Сгенерировано `scripts/third-party-licenses.py` 17.10.2026. Руками не править — перезапустить скрипт.
> Оценка лицензий, модели и образы — в [third-party-licenses.md](third-party-licenses.md).
> ⚠️ — копилефт (GPL, LGPL, AGPL, MPL и т. п.): разбор в оценке.

Только зависимости, которые попадают в образы: без dev-пакетов Node.js и без группы `dev` у ML.

## services/api (Node.js)

Пакетов: 127. MIT — 104, ISC — 8, Apache-2.0 — 5, BSD-3-Clause — 4, 0BSD — 2, Bitstream Vera Fonts License (свободная) — 1, (MIT OR GPL-3.0-or-later) — 1, (MIT AND Zlib) — 1, BlueOak-1.0.0 — 1.

| Пакет | Версия | Лицензия |
|---|---|---|
| @fastify/ajv-compiler | 4.0.6 | MIT |
| @fastify/busboy | 3.2.2 | MIT |
| @fastify/cors | 11.3.0 | MIT |
| @fastify/deepmerge | 3.2.1 | MIT |
| @fastify/error | 4.2.0 | MIT |
| @fastify/fast-json-stringify-compiler | 5.1.0 | MIT |
| @fastify/forwarded | 3.0.2 | MIT |
| @fastify/jwt | 10.2.2 | MIT |
| @fastify/merge-json-schemas | 0.2.1 | MIT |
| @fastify/multipart | 10.1.1 | MIT |
| @fastify/proxy-addr | 5.1.1 | MIT |
| @lukeed/ms | 2.0.2 | MIT |
| @noble/ciphers | 1.3.0 | MIT |
| @noble/hashes | 1.8.0 | MIT |
| @opentelemetry/api | 1.9.1 | Apache-2.0 |
| @pdf-lib/standard-fonts | 1.0.0 | MIT |
| @pdf-lib/upng | 1.0.1 | MIT |
| @pinojs/redact | 0.4.0 | MIT |
| @seriousme/openapi-schema-validator | 2.9.1 | MIT |
| @swc/helpers | 0.5.23 | Apache-2.0 |
| @types/node | 25.9.7 | MIT |
| abstract-logging | 2.0.1 | MIT |
| ajv | 8.20.0 | MIT |
| ajv-draft-04 | 1.0.0 | MIT |
| ajv-formats | 3.0.1 | MIT |
| asn1.js | 5.4.1 | MIT |
| atomic-sleep | 1.0.0 | MIT |
| avvio | 9.3.0 | MIT |
| base64-js | 0.0.8 | MIT |
| base64-js | 1.5.1 | MIT |
| bintrees | 1.0.2 | MIT |
| bn.js | 4.12.5 | MIT |
| brotli | 1.3.3 | MIT |
| browserify-zlib | 0.2.0 | MIT |
| clone | 2.1.2 | MIT |
| cookie | 1.1.1 | MIT |
| core-util-is | 1.0.3 | MIT |
| dejavu-fonts-ttf | 2.37.3 | Bitstream Vera Fonts License (свободная) |
| dequal | 2.0.3 | MIT |
| dfa | 1.2.0 | MIT |
| docx | 9.7.1 | MIT |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 |
| fast-decode-uri-component | 1.0.1 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-json-stringify | 7.0.1 | MIT |
| fast-jwt | 6.3.3 | Apache-2.0 |
| fast-querystring | 1.1.2 | MIT |
| fast-uri | 3.1.8 | BSD-3-Clause |
| fast-uri | 4.1.5 | BSD-3-Clause |
| fastfall | 1.5.1 | MIT |
| fastify | 5.12.5 | MIT |
| fastify-openapi-glue | 4.11.4 | MIT |
| fastify-plugin | 6.0.0 | MIT |
| fastparallel | 2.4.1 | ISC |
| fastq | 1.20.3 | ISC |
| fastseries | 1.7.2 | ISC |
| fflate | 0.8.3 | MIT |
| find-my-way | 9.9.0 | MIT |
| fontkit | 2.0.4 | MIT |
| hash.js | 1.1.7 | MIT |
| immediate | 3.0.6 | MIT |
| inherits | 2.0.4 | ISC |
| ipaddr.js | 2.5.0 | MIT |
| isarray | 1.0.0 | MIT |
| js-md5 | 0.8.3 | MIT |
| json-schema-ref-resolver | 3.0.0 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| jszip | 3.10.2 | (MIT OR GPL-3.0-or-later) ⚠️ |
| lie | 3.3.0 | MIT |
| light-my-request | 6.6.0 | BSD-3-Clause |
| linebreak | 1.1.0 | MIT |
| minimalistic-assert | 1.0.1 | ISC |
| mnemonist | 0.40.4 | MIT |
| nanoid | 5.1.16 | MIT |
| obliterator | 2.0.5 | MIT |
| on-exit-leak-free | 2.1.2 | MIT |
| pako | 0.2.9 | MIT |
| pako | 1.0.11 | (MIT AND Zlib) |
| pdf-lib | 1.17.1 | MIT |
| pdfkit | 0.19.1 | MIT |
| pdfmake | 0.3.11 | MIT |
| pino | 10.3.1 | MIT |
| pino-abstract-transport | 3.0.0 | MIT |
| pino-std-serializers | 7.1.0 | MIT |
| png-js | 1.1.0 | MIT |
| process-nextick-args | 2.0.1 | MIT |
| process-warning | 4.0.1 | MIT |
| process-warning | 5.1.0 | MIT |
| prom-client | 15.1.3 | Apache-2.0 |
| quick-format-unescaped | 4.0.4 | MIT |
| readable-stream | 2.3.8 | MIT |
| real-require | 0.2.0 | MIT |
| real-require | 1.0.0 | MIT |
| require-from-string | 2.0.2 | MIT |
| restructure | 3.0.2 | MIT |
| ret | 0.5.0 | MIT |
| reusify | 1.1.0 | MIT |
| rfdc | 1.4.1 | MIT |
| safe-buffer | 5.1.2 | MIT |
| safe-buffer | 5.2.1 | MIT |
| safe-regex2 | 5.1.1 | MIT |
| safe-stable-stringify | 2.5.0 | MIT |
| safer-buffer | 2.1.2 | MIT |
| sax | 1.6.1 | BlueOak-1.0.0 |
| secure-json-parse | 4.1.0 | BSD-3-Clause |
| semver | 7.8.5 | ISC |
| set-cookie-parser | 2.7.2 | MIT |
| setimmediate | 1.0.5 | MIT |
| sonic-boom | 4.2.1 | MIT |
| split2 | 4.2.0 | ISC |
| steed | 1.1.3 | MIT |
| string_decoder | 1.1.1 | MIT |
| tdigest | 0.1.3 | MIT |
| thread-stream | 4.2.0 | MIT |
| tiny-inflate | 1.0.3 | MIT |
| toad-cache | 3.7.4 | MIT |
| tslib | 1.14.1 | 0BSD |
| tslib | 2.8.1 | 0BSD |
| undici-types | 7.24.6 | MIT |
| unicode-properties | 1.4.1 | MIT |
| unicode-trie | 2.0.0 | MIT |
| util-deprecate | 1.0.2 | MIT |
| xml | 1.0.1 | MIT |
| xml-js | 1.6.11 | MIT |
| xmldoc | 2.0.3 | MIT |
| xtend | 4.0.2 | MIT |
| yaml | 2.9.1 | ISC |

## services/web (Node.js)

Пакетов: 93. MIT — 91, OFL-1.1 — 1, Apache-2.0 — 1.

| Пакет | Версия | Лицензия |
|---|---|---|
| @ant-design/colors | 7.2.1 | MIT |
| @ant-design/cssinjs | 1.24.0 | MIT |
| @ant-design/cssinjs-utils | 1.1.3 | MIT |
| @ant-design/fast-color | 2.0.6 | MIT |
| @ant-design/icons | 5.6.1 | MIT |
| @ant-design/icons-svg | 4.6.0 | MIT |
| @ant-design/react-slick | 1.1.2 | MIT |
| @babel/runtime | 7.29.7 | MIT |
| @emotion/hash | 0.8.0 | MIT |
| @emotion/unitless | 0.7.5 | MIT |
| @fontsource/inter | 5.3.0 | OFL-1.1 |
| @napi-rs/canvas | 1.0.9 | MIT |
| @napi-rs/canvas-android-arm64 | 1.0.9 | MIT |
| @napi-rs/canvas-darwin-arm64 | 1.0.9 | MIT |
| @napi-rs/canvas-darwin-x64 | 1.0.9 | MIT |
| @napi-rs/canvas-linux-arm-gnueabihf | 1.0.9 | MIT |
| @napi-rs/canvas-linux-arm64-gnu | 1.0.9 | MIT |
| @napi-rs/canvas-linux-arm64-musl | 1.0.9 | MIT |
| @napi-rs/canvas-linux-riscv64-gnu | 1.0.9 | MIT |
| @napi-rs/canvas-linux-x64-gnu | 1.0.9 | MIT |
| @napi-rs/canvas-linux-x64-musl | 1.0.9 | MIT |
| @napi-rs/canvas-win32-arm64-msvc | 1.0.9 | MIT |
| @napi-rs/canvas-win32-x64-msvc | 1.0.9 | MIT |
| @rc-component/async-validator | 5.1.2 | MIT |
| @rc-component/color-picker | 2.0.1 | MIT |
| @rc-component/context | 1.4.0 | MIT |
| @rc-component/mini-decimal | 1.1.4 | MIT |
| @rc-component/mutate-observer | 1.1.0 | MIT |
| @rc-component/portal | 1.1.2 | MIT |
| @rc-component/qrcode | 1.1.3 | MIT |
| @rc-component/tour | 1.15.1 | MIT |
| @rc-component/trigger | 2.3.1 | MIT |
| @remix-run/router | 1.23.4 | MIT |
| @tanstack/query-core | 5.103.1 | MIT |
| @tanstack/react-query | 5.103.1 | MIT |
| antd | 5.29.3 | MIT |
| classnames | 2.5.1 | MIT |
| compute-scroll-into-view | 3.1.1 | MIT |
| copy-to-clipboard | 3.3.3 | MIT |
| csstype | 3.2.3 | MIT |
| dayjs | 1.11.23 | MIT |
| js-tokens | 4.0.0 | MIT |
| json2mq | 0.2.0 | MIT |
| loose-envify | 1.4.0 | MIT |
| openapi-fetch | 0.13.8 | MIT |
| openapi-typescript-helpers | 0.0.15 | MIT |
| pdfjs-dist | 6.3.289 | Apache-2.0 |
| rc-cascader | 3.34.0 | MIT |
| rc-checkbox | 3.5.0 | MIT |
| rc-collapse | 3.9.0 | MIT |
| rc-dialog | 9.6.0 | MIT |
| rc-drawer | 7.3.0 | MIT |
| rc-dropdown | 4.2.1 | MIT |
| rc-field-form | 2.7.1 | MIT |
| rc-image | 7.12.0 | MIT |
| rc-input | 1.8.0 | MIT |
| rc-input-number | 9.5.0 | MIT |
| rc-mentions | 2.20.0 | MIT |
| rc-menu | 9.16.1 | MIT |
| rc-motion | 2.9.5 | MIT |
| rc-notification | 5.6.4 | MIT |
| rc-overflow | 1.5.0 | MIT |
| rc-pagination | 5.1.0 | MIT |
| rc-picker | 4.11.3 | MIT |
| rc-progress | 4.0.0 | MIT |
| rc-rate | 2.13.1 | MIT |
| rc-resize-observer | 1.4.3 | MIT |
| rc-segmented | 2.7.1 | MIT |
| rc-select | 14.16.8 | MIT |
| rc-slider | 11.1.9 | MIT |
| rc-steps | 6.0.1 | MIT |
| rc-switch | 4.1.0 | MIT |
| rc-table | 7.54.0 | MIT |
| rc-tabs | 15.7.0 | MIT |
| rc-textarea | 1.10.2 | MIT |
| rc-tooltip | 6.4.0 | MIT |
| rc-tree | 5.13.1 | MIT |
| rc-tree-select | 5.27.0 | MIT |
| rc-upload | 4.11.0 | MIT |
| rc-util | 5.44.4 | MIT |
| rc-virtual-list | 3.19.2 | MIT |
| react | 18.3.1 | MIT |
| react-dom | 18.3.1 | MIT |
| react-is | 18.3.1 | MIT |
| react-router | 6.30.6 | MIT |
| react-router-dom | 6.30.6 | MIT |
| resize-observer-polyfill | 1.5.1 | MIT |
| scheduler | 0.23.2 | MIT |
| scroll-into-view-if-needed | 3.1.0 | MIT |
| string-convert | 0.2.1 | MIT |
| stylis | 4.4.0 | MIT |
| throttle-debounce | 5.0.2 | MIT |
| toggle-selection | 1.0.6 | MIT |

## services/rin-mock (Node.js)

Пакетов: 0. Сторонних пакетов нет, только стандартная библиотека Node.js.

## services/ml (Python, extras: ocr, embeddings)

Пакетов: 102. MIT — 27, BSD-3-Clause — 17, Apache-2.0 — 12, BSD License — 5, Apache 2.0 — 3, Apache License 2.0 — 3, MIT License — 3, Apache Software License — 3, PSF-2.0 — 2, Apache-2.0 OR BSD-3-Clause — 2, BSD — 2, Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT — 2, Apache-2.0 AND MIT — 1, MPL-2.0 — 1, MIT-0 — 1, 0BSD — 1, LGPL-2.1-or-later — 1, Apache-2.0 OR BSD-2-Clause — 1, MIT-CMU — 1, Apache-2.0 AND BSD-2-Clause — 1, 3-Clause BSD License — 1, BSD, Public Domain — 1, BSD-2-Clause — 1, Dual Licensed - GNU AFFERO GPL 3.0 or Artifex Commercial Lic — 1, BSD-3-Clause, Apache-2.0, dependency licenses — 1, GNU Library or Lesser General Public License (LGPL) — 1, Apache-2.0 AND CNRI-Python — 1, BSD 3-Clause — 1, ISC License — 1, MIT OR Apache-2.0 — 1, MPL-2.0 AND MIT — 1, Apache 2.0 License — 1, BSD-3-Clause AND TCL — 1.

| Пакет | Версия | Лицензия |
|---|---|---|
| aiohappyeyeballs | 2.7.1 | PSF-2.0 |
| aiohttp | 3.14.3 | Apache-2.0 AND MIT |
| aiosignal | 1.4.0 | Apache 2.0 |
| aistudio-sdk | 0.3.9 | Apache-2.0 |
| annotated-doc | 0.0.5 | MIT |
| annotated-types | 0.8.0 | MIT |
| anyio | 4.15.1 | MIT |
| attrs | 26.1.0 | MIT |
| bce-python-sdk | 0.9.79 | Apache License 2.0 |
| certifi | 2026.7.22 | MPL-2.0 ⚠️ |
| cffi | 2.1.1 | MIT-0 |
| chardet | 7.6.0 | 0BSD |
| charset-normalizer | 3.5.1 | MIT |
| click | 8.5.0 | BSD-3-Clause |
| cloudpickle | 3.1.2 | BSD-3-Clause |
| colorama | 0.4.6 | BSD License |
| colorlog | 6.12.0 | MIT License |
| crc32c | 2.9.post0 | LGPL-2.1-or-later ⚠️ |
| cryptography | 50.0.1 | Apache-2.0 OR BSD-3-Clause |
| fastapi | 0.141.1 | MIT |
| filelock | 4.0.0 | MIT |
| frozenlist | 1.8.0 | Apache-2.0 |
| fsspec | 2026.7.0 | BSD-3-Clause |
| future | 1.0.0 | MIT |
| h11 | 0.16.0 | MIT |
| hf-xet | 1.6.0 | Apache-2.0 |
| httpcore | 1.0.9 | BSD-3-Clause |
| httpx | 0.28.1 | BSD-3-Clause |
| huggingface-hub | 1.32.0 | Apache-2.0 |
| idna | 3.20 | BSD-3-Clause |
| imagesize | 2.0.1 | MIT |
| jinja2 | 3.1.6 | BSD License |
| joblib | 1.6.0 | BSD-3-Clause |
| markdown-it-py | 4.2.0 | MIT License |
| markupsafe | 3.0.3 | BSD-3-Clause |
| mdurl | 0.1.2 | MIT License |
| modelscope | 1.40.1 | Apache-2.0 |
| modelscope-hub | 0.4.3 | Apache-2.0 |
| mpmath | 1.3.0 | BSD |
| multidict | 6.9.0 | Apache License 2.0 |
| narwhals | 2.26.0 | MIT |
| networkx | 3.6.1 | BSD-3-Clause |
| numpy | 2.3.5 | BSD License |
| opencv-contrib-python | 4.10.0.84 | Apache 2.0 |
| opencv-python-headless | 5.0.0.93 | Apache 2.0 |
| opt-einsum | 3.3.0 | MIT |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause |
| paddleocr | 3.7.0 | Apache License 2.0 |
| paddlepaddle | 3.3.1 | Apache Software License |
| paddlex | 3.7.2 | Apache-2.0 |
| pandas | 3.0.6 | BSD License |
| pillow | 12.3.0 | MIT-CMU |
| prettytable | 3.18.0 | BSD-3-Clause |
| prometheus-client | 0.26.0 | Apache-2.0 AND BSD-2-Clause |
| propcache | 0.5.4 | Apache-2.0 |
| protobuf | 7.36.2 | 3-Clause BSD License |
| psutil | 7.2.2 | BSD-3-Clause |
| py-cpuinfo | 9.0.0 | MIT |
| pyclipper | 1.4.0 | MIT |
| pycparser | 3.0 | BSD-3-Clause |
| pycryptodome | 3.23.0 | BSD, Public Domain |
| pydantic | 2.13.5 | MIT |
| pydantic-core | 2.46.5 | MIT |
| pydantic-settings | 2.15.0 | MIT |
| pygments | 2.21.0 | BSD-2-Clause |
| pymupdf | 1.28.2 | Dual Licensed - GNU AFFERO GPL 3.0 or Artifex Commercial Lic ⚠️ |
| pypdfium2 | 5.13.0 | BSD-3-Clause, Apache-2.0, dependency licenses |
| python-bidi | 0.6.11 | GNU Library or Lesser General Public License (LGPL) ⚠️ |
| python-dateutil | 2.9.0.post0 | Apache-2.0 OR BSD-3-Clause |
| python-dotenv | 1.2.3 | BSD-3-Clause |
| pyyaml | 6.0.2 | MIT |
| rapidfuzz | 3.14.6 | MIT |
| regex | 2026.9.10 | Apache-2.0 AND CNRI-Python |
| requests | 2.34.2 | Apache-2.0 |
| rich | 15.0.0 | MIT |
| ruamel-yaml | 0.19.1 | MIT |
| safetensors | 0.8.0 | Apache Software License |
| scikit-learn | 1.9.1 | BSD-3-Clause |
| scipy | 1.18.1 | BSD License |
| sentence-transformers | 6.1.0 | Apache-2.0 |
| setuptools | 84.0.0 | MIT |
| shapely | 2.1.2 | BSD 3-Clause |
| shellingham | 1.5.4 | ISC License |
| six | 1.17.0 | MIT |
| starlette | 1.6.0 | BSD-3-Clause |
| structlog | 26.1.0 | MIT OR Apache-2.0 |
| sympy | 1.14.0 | BSD |
| threadpoolctl | 3.7.0 | BSD-3-Clause |
| tokenizers | 0.23.2 | Apache Software License |
| torch | 2.14.0 | Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT |
| torch | 2.14.0+cpu | Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT |
| tqdm | 4.70.1 | MPL-2.0 AND MIT ⚠️ |
| transformers | 5.17.0 | Apache 2.0 License |
| typer | 0.26.8 | MIT |
| typing-extensions | 4.16.0 | PSF-2.0 |
| typing-inspection | 0.4.4 | MIT |
| tzdata | 2026.4 | Apache-2.0 |
| ujson | 6.0.0 | BSD-3-Clause AND TCL |
| urllib3 | 2.8.0 | MIT |
| uvicorn | 0.53.0 | BSD-3-Clause |
| wcwidth | 0.8.4 | MIT |
| yarl | 1.25.1 | Apache-2.0 |
