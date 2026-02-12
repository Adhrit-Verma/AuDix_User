# 🎧 AuDiX – User Portal

> A Local-Intranet Audio Streaming Platform

AuDiX (Audio Distribution Exchange) is a lightweight, high-performance **local network audio streaming system** designed for private communities, societies, campuses, or closed networks.

The **User Portal** allows listeners to securely access live audio streams, view metadata, and interact with the system — all within a controlled intranet environment.

---

## 🚀 Overview

AuDiX is built to operate entirely inside a local network without relying on external cloud infrastructure. It provides:

* 🎵 Real-time low-latency audio streaming
* 👤 Secure user authentication
* 🧠 Lightweight JSON/Postgres-backed user management
* 📡 Intranet-first architecture
* ⚡ Optimized Node.js streaming server
* 🛡️ Role-based access (User / Admin separation)

---

## 🧩 Core Features

### 🎧 Live Audio Streaming

* Stream audio across local Wi-Fi
* Designed for society-wide broadcast
* Minimal buffering & low latency

### 🔐 Authentication System

* Secure login system
* Session-based access
* Optional admin route separation

### 📊 User Dashboard

* Stream status indicator
* Active session handling
* Lightweight UI for low resource usage

### ⚙️ Scalable Architecture

* Node.js powered backend
* Modular structure
* Easy to migrate from JSON DB → PostgreSQL
* Designed for multi-tenant expansion

---

## 🏗️ Tech Stack

| Layer      | Technology                     |
| ---------- | ------------------------------ |
| Backend    | Node.js (Express)              |
| Streaming  | Native HTTP Audio Streaming    |
| Database   | JSON / PostgreSQL (Pluggable)  |
| Frontend   | HTML, CSS, Vanilla JS          |
| Deployment | Local Server / Private Network |

---

## 🌐 Architecture Philosophy

AuDiX is designed around three principles:

1. **Local First** – No external dependency required
2. **Lightweight** – Runs on minimal hardware
3. **Community Centric** – Built for private controlled networks

It can be deployed on:

* Local PC server
* Raspberry Pi node
* Private LAN server

---

## 🛠️ Installation

```bash
git clone <repo-url>
cd audix-user
npm install
npm start
```

Server runs on:

```
http://localhost:PORT
```

---

## 🔒 Access Model

* Normal users → User Dashboard
* Admin flagged users → Redirected to Admin Panel
* Admin access requires admin-specific authentication layer

---

## 📦 Roadmap

* [ ] PostgreSQL full migration
* [ ] Admin analytics panel
* [ ] Real-time active user monitoring
* [ ] Multi-channel streaming
* [ ] Invite-code based onboarding
* [ ] IoT node integration

---

## 🧠 Vision

AuDiX isn’t just a streaming app.
It’s a **private digital broadcasting infrastructure** for communities.

Built to scale from:

> One Wi-Fi router → Entire residential ecosystem.

---

## 👨‍💻 Author

**Adhrit Verma (KD)**
Gen-AI + Full Stack Hybrid Engineer
Building local-first intelligent systems.

---

