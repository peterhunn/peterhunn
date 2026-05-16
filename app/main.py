from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import agent_types, chains, tasks
from app.database import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(
    title="AI Consulting Platform",
    description="Agent orchestration engine for AI-augmented enterprise consulting",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(agent_types.router)
app.include_router(tasks.router)
app.include_router(chains.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
