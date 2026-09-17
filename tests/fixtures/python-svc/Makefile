PYTHON ?= python3
DATABASE_URL ?= postgresql://svc:make-fixture-secret-3b9d@localhost:5432/svc

.PHONY: test migrate serve lint

test:
	pytest -q

migrate:
	alembic upgrade head

serve:
	uvicorn app.main:app --reload --port 8000

lint:
	ruff check .
