# CrewPilot API (Minimal)

Base URL: `https://crewpilot.onrender.com`

Versioned base URL: `https://crewpilot.onrender.com/api/v1`

All responses use one of:

- `{ "data": ... }`
- `{ "error": "message" }`

## Auth

- `POST /auth/login` (legacy alias: `POST /login`)
- `POST /auth/register` (legacy alias: `POST /create-store`)

Request body for register:

```json
{
  "username": "jess",
  "password": "secret",
  "storeName": "Jess Store"
}
```

Both login and register return a JWT token in `data.token`.

## Authorization

For protected endpoints, send:

`Authorization: Bearer <token>`

## Core Endpoints

- `GET /health`
- `GET /me`
- `GET /me/store`
- `GET /me/employees`
- `POST /me/employees`
- `PUT /me/employees/:id`
- `DELETE /me/employees/:id`
- `GET /shifts`
- `POST /shifts`
- `PUT /shifts/:id`
- `DELETE /shifts/:id`
- `GET /shift-pool`
- `POST /shift-pool`
- `PUT /shift-pool/:id`
- `DELETE /shift-pool/:id`
- `GET /sent-days`
- `POST /sent-days`
- `DELETE /sent-days/:date`
