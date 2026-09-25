from pathlib import Path


def save_to_downloads(filename: str, content: str) -> str:
    downloads = Path.home() / "Downloads"
    downloads.mkdir(exist_ok=True)
    path = downloads / filename
    path.write_text(content, encoding="utf-8")
    return str(path)
