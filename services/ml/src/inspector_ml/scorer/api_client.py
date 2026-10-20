"""Клиент к api для обучения: вход, выгрузка версии набора, её хеши, регистрация модели.

Вход — логин и пароль учётной записи с ролью `ML_ENGINEER` из окружения (`ML_API_LOGIN`,
`ML_API_PASSWORD`). В код и в журнал они не попадают.
"""

from __future__ import annotations

from typing import Any

import httpx

PREFIX = "/api/v1"


class ApiError(RuntimeError):
    """api ответил ошибкой: текст — для человека, с кодом ответа."""


class InspectorApi:
    def __init__(self, base_url: str, login: str, password: str, *, client: httpx.Client | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._login = login
        self._password = password
        self._client = client or httpx.Client(timeout=60.0)
        self._token: str | None = None

    def export(self, version: str) -> str:
        """JSONL выгрузки версии набора — текстом, как пришёл: по его строкам считаются хеши."""
        return self._get(f"/ml/dataset-versions/{version}/export").text

    def dataset_version(self, version: str) -> dict[str, Any] | None:
        """Описание выпущенной версии (с `split_hashes`), если она есть."""
        versions = self._get("/ml/dataset-versions").json()
        return next((v for v in versions if v.get("version") == version), None)

    def register(self, registration: dict[str, Any]) -> dict[str, Any]:
        """Зарегистрировать модель: api сверит хеши набора и посчитает пороги §14 и регрессию."""
        response = self._client.post(f"{self.base_url}{PREFIX}/ml/models", json=registration, headers=self._auth())
        _raise(response)
        return response.json()

    def _get(self, path: str) -> httpx.Response:
        response = self._client.get(f"{self.base_url}{PREFIX}{path}", headers=self._auth())
        _raise(response)
        return response

    def _auth(self) -> dict[str, str]:
        if self._token is None:
            if not self._login or not self._password:
                raise ApiError("нет ML_API_LOGIN / ML_API_PASSWORD — войти в api нечем")
            response = self._client.post(
                f"{self.base_url}{PREFIX}/auth/login", json={"login": self._login, "password": self._password}
            )
            _raise(response)
            self._token = str(response.json()["access_token"])
        return {"Authorization": f"Bearer {self._token}"}


def _raise(response: httpx.Response) -> None:
    if response.is_success:
        return
    try:
        detail = response.json().get("message") or response.text
    except ValueError:
        detail = response.text
    raise ApiError(f"{response.request.method} {response.request.url.path}: {response.status_code} {detail}")
