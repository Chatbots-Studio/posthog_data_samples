# PostHog — тестові події (кешбек)

Два кроки: **згенерувати** JSON-файли подій у папку `місяць-рік` (`YYYY-MM`) і **окремо відправити** їх у PostHog (EU).

## Вимоги

- Node.js **18+**

## Що генерується

| Файл у папці періоду | Подія | Кількість |
|----------------------|--------|-----------|
| `cashback_section_viewed.json` | `cashback_section_viewed` | 5000 |
| `cashback_types_selected.json` | `cashback_types_selected` | 2000 |
| `client_transaction.json` | `client_transaction` | 30000 |
| `meta.json` | — | метадані періоду та лічильники |

Логіка тих самих сегментів клієнтів, що й раніше: `test_client_00001` … `test_client_08000`, перегляди / вибір / транзакції. У `client_transaction` є `cashback_credited` і **`cashback_amount`** (UAH): якщо кешбек не нараховано — `0`, якщо нараховано — частка від `amount` (приблизно 0,3–8%).

## 1. Генерація файлів

Створює каталог `<--dir>/<YYYY-MM>/` (за замовчуванням `events/2026-03/`):

```bash
node generate-events.js --month 2026-03
```

Інша базова папка:

```bash
node generate-events.js --month 2026-03 --dir ./my-data
```

Синонім: `--period` замість `--month`.

## 2. Відправка в PostHog

Читає файли з `events/<YYYY-MM>/` (або `--dir` + період):

```bash
export POSTHOG_API_KEY="phc_ваш_ключ"
node send-events.js --month 2026-03
```

`--period` — те саме, що `--month` (вказує **яку папку** брати, наприклад `2026-03`).

Частина наборів:

```bash
node send-events.js --month 2026-03 --only views
node send-events.js --month 2026-03 --only selections
node send-events.js --month 2026-03 --only transactions
```

Без мережі (лише підрахунок):

```bash
node send-events.js --month 2026-03 --dry-run
```

Інший шлях до згенерованих даних:

```bash
node send-events.js --period 2026-03 --dir ./my-data
```

Пакети на API: `--batch-size` (за замовчуванням 100).

Під час відправки виводиться **прогрес** (у інтерактивному терміналі один оновлюваний рядок; у пайпі — рідші рядки приблизно кожні 5%). Вимкнути: `--no-progress`.

## npm-скрипти

```bash
npm run generate -- --month 2026-03
npm run send -- --month 2026-03
npm run send:dry-run -- --month 2026-03
```

## Змінні середовища

| Змінна | Опис |
|--------|------|
| `POSTHOG_API_KEY` | Ключ проєкту (`phc_...`). Потрібен для `send-events.js` (крім `--dry-run`). |

## Формат API

Endpoint: `POST https://eu.i.posthog.com/capture/`  
Відправка йде пакетами `batch` (див. попередню версію README / документацію PostHog).

## Безпека

Не комітьте ключ API. У цьому репозиторії зразки JSON у `events/` зберігаються навмисно; для локальних експериментів без коміту великих файлів додайте `events/` у свій `.gitignore`.

## PostHog Instrumentation

Імена подій у **snake_case** та властивості узгоджені з рекомендаціями skill **posthog-instrumentation**.
