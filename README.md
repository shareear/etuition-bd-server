### ⚙️ Server-Side README (`/server/README.md`)

```markdown
# ⚙️ ETUITION BD - Server

The robust backend engine powering the ETUITION BD ecosystem. Built with **Node.js** and **Express 5.0**, it handles secure data persistence, authentication, and financial transactions.



## 🛡️ Core Backend Features

* **Secure API Architecture:** Protected via **JSON Web Tokens (JWT)** and custom middleware for role-based authorization.
* **Firebase Admin SDK Integration:** Handles server-side user verification and secure access to Firebase services.
* **Stripe Financial Engine:** Manages `payment-intent` creation and secure transaction logging for tuition fees.
* **Platform Revenue Logic:** Automatic calculation of the 20% total platform cut (10% student side, 10% tutor side).
* **Real-time Logic:** Handles contract terminations, hiring requests, and tuition status updates via MongoDB aggregation.

## 🛠️ Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js 5.2.1
- **Database:** MongoDB
- **Security:** JSONWebToken (JWT) & Firebase-Admin
- **Payments:** Stripe Node.js Library
- **Environment Management:** Dotenv & CORS

## 📂 Key API Endpoints

### Auth & User
- `POST /jwt`: Generate session tokens.
- `GET /user-stats/:email`: Fetch role-specific statistics.

### Management
- `GET /admin/analytics`: Aggregate financial data for platform charts.
- `GET /ongoing-tuitions/:email`: Role-based fetching of active contracts.
- `PATCH /applications/status/:id`: Approve or reject hiring requests.

### Payments
- `POST /create-payment-intent`: Initialize secure Stripe sessions.
- `POST /payments`: Record successful transactions and update tuition status.

## 📦 Installation & Setup

1. **Install dependencies:**
   ```bash
   npm install
Environment Variables: Create a .env file in the root:
