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

const JWT_SECRET = process.env.JWT_SECRET || 'weather_app_secret_key_change_me';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : false
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                login VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                is_admin BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ База данных готова (таблица users)');
    } catch (e) {
        console.error('❌ Ошибка инициализации БД:', e.message);
    }
}
initDB();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// РЕГИСТРАЦИЯ
// ============================================
app.post('/api/register', async (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполни все поля' });
    if (login.length < 3 || password.length < 4) return res.status(400).json({ error: 'Логин от 3 символов, пароль от 4' });

    try {
        const existing = await pool.query('SELECT id FROM users WHERE login = $1', [login]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'Такой логин уже занят' });

        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (login, password, is_admin) VALUES ($1, $2, FALSE) RETURNING id',
            [login, hash]
        );
        const token = jwt.sign({ id: result.rows[0].id, login }, JWT_SECRET, { expiresIn: '7d' });

        console.log(`✅ Новый пользователь: ${login}`);
        res.json({ success: true, token, login, is_admin: false });
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
    if (!login || !password) return res.status(400).json({ error: 'Заполни все поля' });

    try {
        const result = await pool.query('SELECT * FROM users WHERE login = $1', [login]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Неверный логин или пароль' });

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Неверный логин или пароль' });

        const token = jwt.sign({ id: user.id, login: user.login }, JWT_SECRET, { expiresIn: '7d' });
        console.log(`🔑 Вход: ${login} (админ: ${user.is_admin})`);
        res.json({ success: true, token, login: user.login, is_admin: user.is_admin });
    } catch (e) {
        console.error('Ошибка входа:', e.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============================================
// ПРОВЕРКА ТОКЕНА
// ============================================
app.post('/api/verify', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(401).json({ error: 'Нет токена' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await pool.query('SELECT is_admin FROM users WHERE login = $1', [decoded.login]);
        res.json({
            success: true,
            login: decoded.login,
            is_admin: user.rows[0] ? user.rows[0].is_admin : false
        });
    } catch (e) {
        res.status(401).json({ error: 'Токен недействителен' });
    }
});

// ============================================
// ВЫДАТЬ / ЗАБРАТЬ АДМИНКУ
// ============================================
app.post('/api/grant-admin', async (req, res) => {
    const { adminLogin, adminPassword, targetLogin, action } = req.body;

    if (!adminLogin || !adminPassword || !targetLogin) {
        return res.status(400).json({ error: 'Заполни все поля' });
    }

    try {
        const admin = await pool.query('SELECT * FROM users WHERE login = $1', [adminLogin]);
        if (admin.rows.length === 0 || !admin.rows[0].is_admin) {
            return res.status(403).json({ error: 'Ты не админ' });
        }

        const match = await bcrypt.compare(adminPassword, admin.rows[0].password);
        if (!match) return res.status(403).json({ error: 'Неверный пароль' });

        const target = await pool.query('SELECT id FROM users WHERE login = $1', [targetLogin]);
        if (target.rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });

        if (targetLogin === adminLogin && action === 'revoke') {
            return res.status(400).json({ error: 'Нельзя забрать админку у себя' });
        }

        const newValue = action === 'revoke' ? false : true;
        await pool.query('UPDATE users SET is_admin = $1 WHERE login = $2', [newValue, targetLogin]);

        console.log(`👑 ${action === 'revoke' ? 'Забрана' : 'Выдана'} админка: ${targetLogin}`);

        res.json({
            success: true,
            message: newValue ? `✅ ${targetLogin} теперь админ` : `❌ ${targetLogin} больше не админ`
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============================================
// WEBSOCKET
// ============================================
let weatherState = {
    rainIntensity: 0,
    phenomenonType: 'rain',
    precipColor: 4,
    precipUnit: 'мм',
    power: 3,
    windSpeed: 0,
    temperature: 15,
    isPrecipActive: false,
    lastLat: null,
    lastLng: null,
    nukeLat: null,
    nukeLng: null,
    nukePower: 3,
    nukeActive: false,
    nukeId: null
};

const clients = new Map();

wss.on('connection', (ws) => {
    const clientId = 'client_' + Math.random().toString(36).substr(2, 9);
    clients.set(clientId, { ws });

    console.log(`✅ Подключен клиент: ${clientId} (всего: ${clients.size})`);
    ws.send(JSON.stringify({ type: 'init', clientId, state: weatherState, onlineCount: clients.size }));

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
// REST
// ============================================
app.get('/api/weather', (req, res) => {
    res.json({ success: true, state: weatherState, onlineCount: clients.size });
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        uptime: process.uptime(),
        onlineCount: clients.size,
        version: '3.0.0',
        db: process.env.DATABASE_URL ? 'connected' : 'not configured'
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║  🌦️  WEATHER SERVER v3.0               ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║  🚀 Порт: ${PORT}                          ║`);
    console.log(`║  🗄️  БД: ${process.env.DATABASE_URL ? 'подключена' : 'НЕ подключена'}              ║`);
    console.log('║  🔐 /api/register /api/login /api/verify║');
    console.log('║  👑 /api/grant-admin                    ║');
    console.log('║  📡 WebSocket активен                   ║');
    console.log('╚════════════════════════════════════════╝');
});

process.on('SIGTERM', () => {
    console.log('Завершение работы...');
    wss.clients.forEach(c => c.close());
    server.close(() => { pool.end(); process.exit(0); });
});
