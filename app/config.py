from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    anthropic_api_key: str
    database_url: str = "sqlite+aiosqlite:///./consulting.db"
    default_model: str = "claude-opus-4-7"
    max_tokens: int = 16000

    class Config:
        env_file = ".env"


settings = Settings()
