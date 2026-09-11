const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ============================================
// НАСТРОЙКИ
// ============================================
const JWT_SECRET = process.env.JWT_SECRET || 'weather_app_secret_key_change_me_in_prod';

// ============================================
// БАЗА ДАННЫХ (PostgreSQL от RelaxDev)
// ============================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : false
});

// Создаём таблицу при старте
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                login VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ База данных готова (таблица users)');
    } catch (e) {
        console.error('❌ Ошибка инициализации БД:', e.message);
    }
}
initDB();

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// РЕГИСТРАЦИЯ
// ============================================
app.post('/api/register', async (req, res) => {
    const { login, password } = req.body;

    if (!login || !password) {
        return res.status(400).json({ error: 'Заполни все поля' });
    }
    if (login.length < 3 || password.length < 4) {
        return res.status(400).json({ error: 'Логин от 3 символов, пароль от 4' });
    }

    try {
        const existing = await pool.query('SELECT id FROM users WHERE login = $1', [login]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Такой логин уже занят' });
        }

        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (login, password) VALUES ($1, $2) RETURNING id',
            [login, hash]
        );

        const token = jwt.sign(
            { id: result.rows[0].id, login },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        console.log(`✅ Новый пользователь: ${login}`);
        res.json({ success: true, token, login });
    } catch (e) {
        console.error('Ошибка регистрации:', e.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============================================
// ВХОД
// ============================================
app.post('/api/login', async (req, res) => {
    const { login, password } = req.body;

    if (!login || !password) {
        return res.status(400).json({ error: 'Заполни все поля' });
    }

    try {
        const result = await pool.query('SELECT * FROM users WHERE login = $1', [login]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const token = jwt.sign(
            { id: user.id, login: user.login },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        console.log(`🔑 Вход: ${login}`);
        res.json({ success: true, token, login: user.login });
    } catch (e) {
        console.error('Ошибка входа:', e.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============================================
// ПРОВЕРКА ТОКЕНА
// ============================================
app.post('/api/verify', (req, res) => {
    const { token } = req.body;

    if (!token) {
        return res.status(401).json({ error: 'Нет токена' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        res.json({ success: true, login: decoded.login });
    } catch (e) {
        res.status(401).json({ error: 'Токен недействителен' });
    }
});

// ============================================
// WEBSOCKET (синхронизация погоды)
// ============================================
let weatherState = {
    rainIntensity: 0,
    phenomenonType: 'rain',
    power: 3,
    windSpeed: 0,
    temperature: 15,
    isPrecipActive: false
};

const clients = new Map();

wss.on('connection', (ws) => {
    const clientId = 'client_' + Math.random().toString(36).substr(2, 9);
    clients.set(clientId, { ws, isAdmin: false });

    console.log(`✅ Подключен клиент: ${clientId} (всего: ${clients.size})`);

    ws.send(JSON.stringify({
        type: 'init',
        clientId,
        state: weatherState,
        onlineCount: clients.size
    }));

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === 'weather_update') {
                weatherState = { ...weatherState, ...msg.state };
                broadcast({ type: 'weather_update', state: weatherState });
            }

            if (msg.type === 'get_state') {
                ws.send(JSON.stringify({ type: 'state', state: weatherState }));
            }

            if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
        } catch (e) {
            console.error('Ошибка WebSocket:', e.message);
        }
    });

    ws.on('close', () => {
        clients.delete(clientId);
        console.log(`❌ Отключен: ${clientId} (осталось: ${clients.size})`);
    });

    ws.on('error', (e) => console.error('WebSocket error:', e.message));
});

function broadcast(msg) {
    const data = JSON.stringify(msg);
    clients.forEach(({ ws }) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
}

// ============================================
// REST API
// ============================================
app.get('/api/weather', (req, res) => {
    res.json({ success: true, state: weatherState, onlineCount: clients.size });
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        uptime: process.uptime(),
        onlineCount: clients.size,
        version: '2.0.0',
        db: process.env.DATABASE_URL ? 'connected' : 'not configured'
    });
});

// ============================================
// ЗАПУСК
// ============================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║  🌦️  WEATHER SERVER v2.0               ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║  🚀 Порт: ${PORT}                          ║`);
    console.log(`║  🗄️  БД: ${process.env.DATABASE_URL ? 'подключена' : 'НЕ подключена'}              ║`);
    console.log('║  🔐 /api/register — регистрация         ║');
    console.log('║  🔑 /api/login    — вход                ║');
    console.log('║  📡 WebSocket     — активен             ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Завершение работы...');
    wss.clients.forEach(c => c.close());
    server.close(() => {
        pool.end();
        process.exit(0);
    });
});
