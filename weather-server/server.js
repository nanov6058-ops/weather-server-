const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// ХРАНИЛИЩЕ СОСТОЯНИЯ ПОГОДЫ
// ============================================

let weatherState = {
    rainIntensity: 0,
    precipType: 'rain',
    tornadoCount: 0,
    tornadoPower: 3,
    windSpeed: 0,
    temperature: 15,
    isPrecipActive: false,
    isSnowActive: false,
    lastUpdate: Date.now(),
    adminId: null // ID админа, который последний раз менял погоду
};

// История изменений (последние 100)
const history = [];

// Подключенные клиенты
const clients = new Map();

// ============================================
// WEBSOCKET ЛОГИКА
// ============================================

wss.on('connection', (ws, req) => {
    const clientId = generateId();
    const clientIp = req.socket.remoteAddress;
    
    clients.set(clientId, {
        ws,
        id: clientId,
        ip: clientIp,
        connectedAt: Date.now(),
        isAdmin: false
    });
    
    console.log(`✅ Клиент подключен: ${clientId} (${clientIp})`);
    console.log(`👥 Всего онлайн: ${clients.size}`);
    
    // Отправляем текущее состояние новому клиенту
    ws.send(JSON.stringify({
        type: 'init',
        clientId: clientId,
        state: weatherState,
        onlineCount: clients.size
    }));
    
    // Уведомляем всех о новом пользователе
    broadcast({
        type: 'user_joined',
        clientId: clientId,
        onlineCount: clients.size
    }, clientId);
    
    // Обработка сообщений
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(clientId, message);
        } catch (e) {
            console.error('Ошибка парсинга:', e);
        }
    });
    
    // Отключение
    ws.on('close', () => {
        clients.delete(clientId);
        console.log(`❌ Клиент отключен: ${clientId}`);
        console.log(`👥 Всего онлайн: ${clients.size}`);
        
        broadcast({
            type: 'user_left',
            clientId: clientId,
            onlineCount: clients.size
        });
    });
    
    // Ошибки
    ws.on('error', (error) => {
        console.error(`Ошибка у клиента ${clientId}:`, error);
    });
});

// ============================================
// ОБРАБОТКА СООБЩЕНИЙ
// ============================================

function handleMessage(clientId, message) {
    const client = clients.get(clientId);
    if (!client) return;
    
    switch (message.type) {
        case 'weather_update':
            // Обновление погоды (только админ)
            if (!client.isAdmin && weatherState.adminId !== null && weatherState.adminId !== clientId) {
                client.ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Только администратор может менять погоду'
                }));
                return;
            }
            
            weatherState = {
                ...weatherState,
                ...message.state,
                lastUpdate: Date.now(),
                adminId: clientId
            };
            
            // Добавляем в историю
            history.push({
                timestamp: Date.now(),
                clientId,
                state: { ...weatherState }
            });
            
            if (history.length > 100) history.shift();
            
            console.log(`🌦️ Погода обновлена админом ${clientId}:`, weatherState);
            
            // Рассылаем всем
            broadcast({
                type: 'weather_update',
                state: weatherState,
                updatedBy: clientId
            });
            break;
            
        case 'admin_login':
            // Вход в админ-панель
            client.isAdmin = true;
            weatherState.adminId = clientId;
            
            console.log(`👑 Админ вошел: ${clientId}`);
            
            broadcast({
                type: 'admin_changed',
                adminId: clientId,
                message: 'Новый администратор подключен'
            });
            break;
            
        case 'admin_logout':
            // Выход из админ-панели
            client.isAdmin = false;
            if (weatherState.adminId === clientId) {
                weatherState.adminId = null;
            }
            
            console.log(`👑 Админ вышел: ${clientId}`);
            
            broadcast({
                type: 'admin_changed',
                adminId: weatherState.adminId,
                message: 'Администратор отключился'
            });
            break;
            
        case 'get_state':
            // Запрос текущего состояния
            client.ws.send(JSON.stringify({
                type: 'state',
                state: weatherState,
                onlineCount: clients.size
            }));
            break;
            
        case 'ping':
            // Пинг для поддержания соединения
            client.ws.send(JSON.stringify({ type: 'pong' }));
            break;
            
        default:
            console.log(`Неизвестный тип сообщения: ${message.type}`);
    }
}

// ============================================
// РАССЫЛКА
// ============================================

function broadcast(message, excludeId = null) {
    const data = JSON.stringify(message);
    
    clients.forEach((client, id) => {
        if (id !== excludeId && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(data);
        }
    });
}

// ============================================
// REST API (для Google Sites и внешних запросов)
// ============================================

// Получить текущее состояние
app.get('/api/weather', (req, res) => {
    res.json({
        success: true,
        state: weatherState,
        onlineCount: clients.size
    });
});

// Обновить погоду (с секретным ключом)
app.post('/api/weather', (req, res) => {
    const { secret, state } = req.body;
    
    // Простая защита (замени на свой ключ!)
    if (secret !== process.env.ADMIN_SECRET && secret !== 'macro_os_secret_2026') {
        return res.status(403).json({
            success: false,
            error: 'Неверный секретный ключ'
        });
    }
    
    weatherState = {
        ...weatherState,
        ...state,
        lastUpdate: Date.now(),
        adminId: 'api'
    };
    
    broadcast({
        type: 'weather_update',
        state: weatherState,
        updatedBy: 'api'
    });
    
    res.json({
        success: true,
        state: weatherState
    });
});

// История изменений
app.get('/api/history', (req, res) => {
    res.json({
        success: true,
        history: history.slice(-20)
    });
});

// Статус сервера
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        uptime: process.uptime(),
        onlineCount: clients.size,
        lastUpdate: weatherState.lastUpdate,
        version: '1.0.0'
    });
});

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function generateId() {
    return 'client_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
}

// ============================================
// ЗАПУСК СЕРВЕРА
// ============================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║  🌦️  WEATHER SYNC SERVER v1.0          ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║  🚀 Порт: ${PORT}                          ║`);
    console.log(`║  🌐 http://localhost:${PORT}              ║`);
    console.log(`║  🔌 WebSocket: ws://localhost:${PORT}     ║`);
    console.log('╠════════════════════════════════════════╣');
    console.log('║  📡 Ожидание подключений...            ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Завершение работы...');
    wss.clients.forEach(client => client.close());
    server.close(() => process.exit(0));
});