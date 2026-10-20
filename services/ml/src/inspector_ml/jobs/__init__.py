"""Приём и выполнение задач от api: очередь, пул процессов, доставка результата."""

from inspector_ml.jobs.callback import CallbackSender
from inspector_ml.jobs.runner import JobRecord, JobRunner, result_envelope

__all__ = ["CallbackSender", "JobRecord", "JobRunner", "result_envelope"]
