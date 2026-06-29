# Vercel — MAX бот

Деплой **этой папки** как корня проекта на [Vercel](https://vercel.com).

| Файл | Назначение |
|------|------------|
| `package.json` | Зависимость `zxing-wasm` (сборка на Vercel) |
| `api/max-webhook.js` | Прокси webhook MAX → 1С |
| `api/_lib/zxing-decode.mjs` | Общий декодер |
| `public/politika-pdn.html` | Статическая политика ПДн (HTTPS после деплоя) |
| `subscribe-webhook.ps1` | Переподписка webhook в MAX |
| `.env.example` | Шаблон переменных окружения |

## Политика ПДн

Файл лежит в `public/` — Vercel отдаёт его как статику без доработки API.

После деплоя URL для поля `СсылкаПолитикиПДн` в условиях акции:

`https://<ваш-домен-vercel>/politika-pdn.html`

Пример: если проект на `max-bot.vercel.app`, ссылка будет  
`https://max-bot.vercel.app/politika-pdn.html`

