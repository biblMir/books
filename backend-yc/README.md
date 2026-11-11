]7;file://ALEX/C:\Users\wwwla\Documents\Codex\2026-11-11\new-chat-3\# API редакторской админки на Yandex Cloud Functions

Публичный каталог остаётся на GitHub Pages. Эта функция проверяет общий вход редакторов, читает и публикует каталог/обложки через GitHub API, а статистику получает из GoatCounter. Она рассчитана на прямой HTTPS endpoint `functions.yandexcloud.net`; API Gateway и Cloudflare не используются.

## Перед запуском

- Нужен аккаунт Yandex Cloud с активным платёжным аккаунтом. До 1 000 000 вызовов функции, 10 ГБ×час выполнения и 100 ГБ исходящего трафика в месяц входят в бесплатные объёмы. Превышение квот тарифицируется; настрой уведомление о расходах в биллинге.
- Не выдавай редакторам доступ к консоли Yandex Cloud. Секреты функции доступны владельцу облака и пользователям с правами менять её настройки.
- Создай fine-grained GitHub token только для `biblMir/books`, с правом `Contents: Read and write`. Этот ключ будет использован только функцией и не попадёт в HTML.
- У GoatCounter уже используется код сайта `lana`. Для панели статистики нужен API token этого счётчика.

## Создание функции

1. Установи [Yandex Cloud CLI](https://yandex.cloud/ru/docs/cli/quickstart) и выполни `yc init`.
2. В нужной папке облака создай функцию `books-admin-api`.
3. Создай версию из этой папки с runtime `nodejs22`, точкой входа `index.handler`, памятью `128 MB`, таймаутом `15 секунд` и исходниками из `backend-yc/`.
4. В настройках версии добавь переменные окружения:

   | Переменная | Значение |
   | --- | --- |
   | `ALLOWED_ORIGIN` | `https://biblmir.github.io` |
   | `GITHUB_OWNER` | `biblMir` |
   | `GITHUB_REPO` | `books` |
   | `GITHUB_BRANCH` | `main` |
   | `GITHUB_TOKEN` | Fine-grained token из шага выше |
   | `ADMIN_LOGIN` | Придуманный общий логин редакторов |
   | `ADMIN_PASSWORD` | Длинная общая парольная фраза |
   | `SESSION_SECRET` | Случайная строка не короче 32 байт |
   | `GOATCOUNTER_CODE` | `lana` |
   | `GOATCOUNTER_TOKEN` | API token GoatCounter |

   Значения в `GITHUB_TOKEN`, `ADMIN_PASSWORD`, `SESSION_SECRET` и `GOATCOUNTER_TOKEN` вводи только в консоли облака. Не вставляй их в чат и не коммить в GitHub.

5. Разреши публичный HTTPS-вызов функции ролью `serverless.functions.invoker` для `system:allUsers`. Публичен только endpoint функции; каталог, публикация и статистика всё равно требуют сессию редактора. `/api/login` ограничен по IP и проверяет общий пароль.
6. Скопируй HTTPS URL функции в `site/admin-config.js`:

   ```js
   window.BOOKS_ADMIN_API = "https://functions.yandexcloud.net/<ID-функции>";
   ```

7. Опубликуй `site/admin.html`, `site/admin-auth.js` и `site/admin-config.js` в `biblMir/books`.

## Работа редакторов

Редакторы открывают `https://biblmir.github.io/books/admin.html`, входят под одним логином и паролем, правят каталог и нажимают «Опубликовать». После входа загружается свежая версия. Если публикацию успел сделать другой редактор, сервер не перезапишет его изменения и попросит обновить каталог.

Статистика остаётся в GoatCounter и в панели админки. Если не задавать `GOATCOUNTER_TOKEN`, публичный счётчик продолжит записывать события, но редакторы не смогут загружать отчёт из админки.

## Лимиты

Cloud Functions ограничивает JSON-запрос/ответ размером 3,5 MB. В админке обложки сжимаются до ширины 600 px; функция отклоняет слишком большие запросы, чтобы не упереться в предел платформы.

