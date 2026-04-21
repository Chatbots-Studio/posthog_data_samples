# PostHog — тестові події активації (цифровий банк)

Генерація і відправка у PostHog подій активації з модуля винагород для цифрового банку, згідно з моделлю воронки L1→L2→L3→L4 (див. `activation_research.md`). За замовчуванням ingest іде в **PostHog Cloud EU**; для **self-hosted** обов’язково задайте `POSTHOG_HOST` (див. нижче).

## Вимоги

- Node.js **18+**

## Як це працює

Задаєте три речі:

1. **M0-місяць** — `--month YYYY-MM` — коли випускається нова когорта карток
2. **Розмір когорти (діапазон)** — `--cards-min` / `--cards-max` — скільки карток випускається (випадкове ціле у цьому діапазоні)
3. **Сценарій** — `--scenario <name>` — пресет поведінки клієнтів, який повністю визначає решту (архетипи, інтенсивність транзакцій, кампанії, розміри контрольних груп тощо)

Генератор симулює поведінку цієї когорти на 4 місяці (**M0, M1, M2, M3**) і створює окрему папку з подіями на кожен календарний місяць:

```
events/
├── 2026-03/    ← M0: випуск карток, welcome-кампанії, перші транзакції
├── 2026-04/    ← M1: формування звички, boost-кешбек
├── 2026-05/    ← M2: habitual клієнти, milestone
└── 2026-06/    ← M3: перехід у револьверів, L4
```

## Сценарії

Чотири готових пресети згідно з `activation_research.md`:

| Сценарій | Воронка L1→L4 | Опис |
|----------|---------------|------|
| `baseline` (дефолт) | 3000→1200→300→150 (п.1.2 базовий) | Банк без модуля винагород, 5% доходять до L4 |
| `target` | 3000→1800→720→504 (п.1.2 цільовий) | З модулем винагород після 3-6 міс впровадження, 17% L4 |
| `conservative` | ~30%/20%/40% переходи | Невеликий регіональний банк, нижча активність |
| `aggressive` | ~70%/50%/80% переходи | Інтенсивний маркетинг, багато кампаній і контрольних груп |

Кожен сценарій задає:
- Розподіл архетипів клієнтів (dormant / occasional / habitual / revolver)
- Середню кількість транзакцій, переглядів, виборів, комунікацій на клієнта на місяць
- Кількість кампаній Категорії A на місяць
- Розміри контрольних груп (exclusion_holdout, tier_downgrade_holdout)

Обсяги подій на кожен календарний місяць обчислюються як `cohort_size × per_client_per_month × month_activity_factor × (1 ± jitter)`.

## Типи подій

10 подій (7 таблиць документа):

| Подія | Таблиця документа | Що представляє |
|-------|-------------------|----------------|
| `card_activated` | 6.1 `card_openings` | L1 — випуск картки в застосунку |
| `transaction_completed` | 6.2 `transactions` | Транзакція з MCC, мерчантом, інтерчейнджем, кешбеком, `is_revolver_tx` |
| `reward_section_viewed` | 6.3 `reward_views` | Перегляд розділу «Ваші кешбеки» |
| `reward_type_selected` | 6.4 `reward_selections` | Вибір MCC-категорій на місяць |
| `communication_sent` | 6.5 `communications` | Надіслана комунікація (push/sms/email/in_app) |
| `communication_delivered` | — | Доставлена |
| `communication_opened` | — | Відкрита |
| `communication_clicked` | — | Клікнута |
| `credit_profile_snapshot` | 6.6 `credit_profiles` | Денний снепшот балансу/ліміту/револьвер-флагу |
| `experiment_assigned` | 6.7 `experiment_assignments` | Призначення в контрольну групу 3 типів |

### Моделі з документа, що враховано

- **Архетипи клієнтів** — задаються сценарієм (dormant / occasional / habitual / revolver)
- **Час до першої tx** — експоненціальний розподіл, медіана ~5 днів (п.1.3)
- **Welcome-бонус 100 грн** на першу tx ≥200 грн у перші 14 днів (П1.2)
- **Boost 4%** на другу tx у перші 7 днів після першої (П2.1)
- **Milestone +50 грн** на 5-ту tx у місяці (П2.3)
- **MCC-кешбек** 2% (standard) або 0.5% (control_group) на обрані категорії (п.4.3)
- **Обмеження частоти комунікацій** (П5.1): ≤2 push/тиждень у перші 30 днів, ≤1 push/день завжди
- **3 типи контрольних груп**:
  - `exclusion_holdout` — 10% ЦА на кожну кампанію Категорії A (п.4.2)
  - `tier_downgrade_holdout` — 5% клієнтів у control_group 12 міс (п.4.3)
  - `staggered_rollout` — 33/33/34 хвилі на нову MCC-конфігурацію (п.4.4)

## 1. Генерація

Мінімально:

```bash
node generate-events.js --month 2026-03
```

З явним сценарієм і розміром когорти:

```bash
node generate-events.js --month 2026-03 --scenario target --cards-min 2500 --cards-max 3500
```

Детермінований запуск через seed:

```bash
node generate-events.js --month 2026-03 --scenario aggressive --seed 42
```

Інша базова папка:

```bash
node generate-events.js --month 2026-03 --dir ./my-data
```

Довідка:

```bash
node generate-events.js --help
```

## 2. Відправка у PostHog

Читає всі файли з `events/<YYYY-MM>/` і відправляє пакетами на **ingest endpoint** PostHog (`POST /capture/`).

### Куди саме йдуть дані (обов’язково прочитайте)

| Змінна | Що робить |
|--------|-----------|
| *(не задано)* | Використовується **PostHog Cloud EU**: `https://eu.i.posthog.com/capture/` |
| `POSTHOG_HOST` | Базовий URL вашого інстансу **або** повний шлях до capture |

Приклади:

```bash
# Cloud EU (те саме, що й без змінної)
export POSTHOG_HOST="https://eu.i.posthog.com"

# Self-hosted: достатньо домену — скрипт додасть /capture/
export POSTHOG_HOST="https://posthog.dev.42flows.tech"

# Або повний ingest URL вручну
export POSTHOG_HOST="https://posthog.dev.42flows.tech/capture/"
```

Якщо раніше ви запускали відправку **без** `POSTHOG_HOST`, події потрапляли в **хмарний EU-проєкт**, чий ключ ви вказали — помилок могло не бути, бо ключ був валідний для хмари. Для інстансу на [https://posthog.dev.42flows.tech](https://posthog.dev.42flows.tech) потрібен **окремий API key з того ж self-hosted проєкту** і змінна `POSTHOG_HOST` як вище.

При кожному запуску на початку виводиться **банер** з точним ingest URL і значенням `POSTHOG_HOST` з середовища (щоб одразу бачити, куди підуть дані).

Перед першою реальною відправкою скрипт **один раз** надсилає тестову подію `probe_connection` і перевіряє відповідь: HTTP **200** і JSON з успішним `status` — у [документації Cloud](https://posthog.com/docs/api/overview#status-code-200) це **`{"status":"Ok"}`**; на багатьох **self-hosted** інстансах (capture backend) замість цього приходить **`{"status":1}`** — це теж нормально, не помилка. Якщо прийшов HTML, порожня відповідь або JSON з `type`/`code` помилки — з’єднання вважається невдалим. Кожен **пакет** реальних подій перевіряється так само. Примусово без початкової перевірки: `node send-events.js --skip-verify` (пакети все одно валідуються по відповіді API).

Якщо перевірка проходить, а в UI подій не видно: перевірте **вибраний проєкт**, діапазон **дат** (час у згенерованих подіях має потрапляти у фільтр), що ключ — саме **Project API Key** (`phc_…`), а не personal API key; на self-hosted можлива невелика затримка індексації.

**Усі згенеровані місяці за раз** (без `--month`):

```bash
export POSTHOG_API_KEY="phc_ваш_ключ"
export POSTHOG_HOST="https://posthog.dev.42flows.tech"   # для self-hosted
node send-events.js
```

Скрипт знайде всі підпапки виду `YYYY-MM` у `--dir` (дефолт `events/`), відсортує за датою і відправить по черзі з проміжним підсумком після кожного місяця і загальним підсумком у кінці.

**Один конкретний місяць**:

```bash
node send-events.js --month 2026-03
```

**Частковий запуск** — за групами або конкретною подією (працює як з `--month`, так і без):

```bash
# Групи:
node send-events.js --only cards
node send-events.js --only transactions
node send-events.js --only views
node send-events.js --only selections
node send-events.js --only communications
node send-events.js --only snapshots
node send-events.js --only experiments

# Окрема подія:
node send-events.js --only card_activated
node send-events.js --only transaction_completed
node send-events.js --only communication_clicked
```

**Без мережі**:

```bash
node send-events.js --dry-run
node send-events.js --month 2026-03 --dry-run
```

**Інший шлях**:

```bash
node send-events.js --dir ./my-data
node send-events.js --month 2026-03 --dir ./my-data
```

Розмір пакета API: `--batch-size` (дефолт 100). Прогрес: у TTY — один оновлюваний рядок; у пайпі — рядки кожні ~5%. Вимкнути: `--no-progress`.

## npm-скрипти

```bash
npm run generate -- --month 2026-03
npm run send                              # усі місяці
npm run send -- --month 2026-03
npm run send:dry-run                      # усі місяці без мережі
npm run send:dry-run -- --month 2026-03
```

## Змінні середовища

| Змінна | Опис |
|--------|------|
| `POSTHOG_API_KEY` | Персональний API key проєкту (`phc_...`). Має бути виданий **тим самим** PostHog, на який вказує `POSTHOG_HOST`. Потрібен для `send-events.js` (крім `--dry-run`). |
| `POSTHOG_HOST` | Необов’язково. Базовий URL інстансу (напр. `https://posthog.dev.42flows.tech`) або повний ingest (`.../capture/`). Якщо не задано — `https://eu.i.posthog.com/capture/` (Cloud EU). |

## Формат API

HTTP: `POST <POSTHOG_HOST або дефолт>/capture/` з тілом `{ "api_key": "...", "batch": [ ... ] }`. Для self-hosted шлях той самий — `/capture/` на вашому домені.

## Безпека

Не комітьте ключ API. Додайте `events/` у свій локальний `.gitignore`, якщо не хочете комітити згенеровані зразки.

## PostHog Instrumentation

Імена подій у **snake_case**, `distinct_id = client_id`, властивості узгоджені з рекомендаціями skill **posthog-instrumentation**. Події об'єднуються у воронки і lift-аналіз через спільні поля `client_id`, `campaign_id`, `experiment_id`, `variant`, `cashback_tier`.
