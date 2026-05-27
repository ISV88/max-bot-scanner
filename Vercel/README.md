# Vercel — MAX бот

Деплой **этой папки** как корня проекта на [Vercel](https://vercel.com).

| Файл | Назначение |
|------|------------|
| `package.json` | Зависимость `zxing-wasm` (сборка на Vercel) |
| `api/max-webhook.js` | Прокси webhook MAX → 1С |
| `api/_lib/zxing-decode.mjs` | Общий декодер |
| `subscribe-webhook.ps1` | Переподписка webhook в MAX |
| `.env.example` | Шаблон переменных окружения |

