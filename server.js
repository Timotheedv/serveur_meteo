const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configuration
const PORT = process.env.PORT || 3000;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const WEATHER_API_URL = 'https://api.openweathermap.org/data/2.5';

// Vérification de la clé API
if (!WEATHER_API_KEY) {
  console.error('❌ ERREUR: Clé API météo manquante!');
  console.log('📝 Ajoutez WEATHER_API_KEY=votre_clé dans le fichier .env');
  process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Stockage en mémoire
const connectedUsers = new Map();
const weatherCache = new Map();
const systemStats = {
  totalConnections: 0,
  totalWeatherRequests: 0,
  alertsSent: 0,
  startTime: Date.now(),
  lastUpdate: null
};

// Service météo
class WeatherService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.cache = new Map();
    this.cacheTimeout = 10 * 60 * 1000; // 10 minutes
  }

  async getCurrentWeather(lat, lon) {
    const cacheKey = `${lat},${lon}`;
    const cached = this.cache.get(cacheKey);
    
    // Vérifier le cache
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      console.log(`📊 Cache utilisé pour ${lat},${lon}`);
      return cached.data;
    }

    try {
      console.log(`🌍 Appel API météo pour ${lat},${lon}`);
      const response = await axios.get(`${WEATHER_API_URL}/weather`, {
        params: {
          lat: lat,
          lon: lon,
          appid: this.apiKey,
          units: 'metric',
          lang: 'fr'
        },
        timeout: 5000
      });

      const weatherData = {
        location: {
          name: response.data.name,
          country: response.data.sys.country,
          lat: lat,
          lon: lon
        },
        current: {
          temperature: Math.round(response.data.main.temp),
          feels_like: Math.round(response.data.main.feels_like),
          humidity: response.data.main.humidity,
          pressure: response.data.main.pressure,
          visibility: Math.round((response.data.visibility || 10000) / 1000),
          wind: {
            speed: Math.round(response.data.wind.speed * 10) / 10,
            direction: response.data.wind.deg,
            gust: Math.round((response.data.wind.gust || 0) * 10) / 10
          },
          weather: {
            main: response.data.weather[0].main,
            description: response.data.weather[0].description,
            icon: response.data.weather[0].icon
          },
          clouds: response.data.clouds.all,
          timestamp: Date.now()
        },
        sun: {
          sunrise: response.data.sys.sunrise * 1000,
          sunset: response.data.sys.sunset * 1000
        }
      };

      // Mettre en cache
      this.cache.set(cacheKey, {
        data: weatherData,
        timestamp: Date.now()
      });

      systemStats.totalWeatherRequests++;
      console.log(`✅ Données météo récupérées pour ${weatherData.location.name}`);
      
      return weatherData;
    } catch (error) {
      console.error('❌ Erreur API météo:', error.response?.data?.message || error.message);
      throw new Error(`Impossible de récupérer les données météo: ${error.response?.data?.message || error.message}`);
    }
  }

  async getForecast(lat, lon) {
    try {
      const response = await axios.get(`${WEATHER_API_URL}/forecast`, {
        params: {
          lat: lat,
          lon: lon,
          appid: this.apiKey,
          units: 'metric',
          lang: 'fr'
        },
        timeout: 5000
      });

      const forecast = response.data.list.slice(0, 5).map(item => ({
        datetime: item.dt * 1000,
        temperature: Math.round(item.main.temp),
        description: item.weather[0].description,
        icon: item.weather[0].icon,
        humidity: item.main.humidity,
        wind_speed: Math.round(item.wind.speed * 10) / 10
      }));

      console.log(`📈 Prévisions récupérées: ${forecast.length} éléments`);
      return forecast;
    } catch (error) {
      console.error('❌ Erreur prévisions météo:', error.message);
      throw new Error('Impossible de récupérer les prévisions');
    }
  }

  async getWeatherAlerts(lat, lon) {
    try {
      const currentWeather = await this.getCurrentWeather(lat, lon);
      const alerts = [];

      // Alertes de température
      if (currentWeather.current.temperature > 35) {
        alerts.push({
          id: uuidv4(),
          type: 'heat_warning',
          severity: 'warning',
          title: '🌡️ Alerte Canicule',
          description: `Température élevée: ${currentWeather.current.temperature}°C`,
          timestamp: Date.now()
        });
      }

      if (currentWeather.current.temperature < -10) {
        alerts.push({
          id: uuidv4(),
          type: 'cold_warning',
          severity: 'warning',
          title: '🥶 Alerte Grand Froid',
          description: `Température très basse: ${currentWeather.current.temperature}°C`,
          timestamp: Date.now()
        });
      }

      // Alertes de vent
      if (currentWeather.current.wind.speed > 15) {
        alerts.push({
          id: uuidv4(),
          type: 'wind_warning',
          severity: 'advisory',
          title: '💨 Alerte Vent Fort',
          description: `Vent fort: ${currentWeather.current.wind.speed} m/s`,
          timestamp: Date.now()
        });
      }

      // Alertes météo spécifiques
      const weatherMain = currentWeather.current.weather.main.toLowerCase();
      if (weatherMain.includes('thunderstorm')) {
        alerts.push({
          id: uuidv4(),
          type: 'storm_warning',
          severity: 'warning',
          title: '⛈️ Alerte Orage',
          description: 'Orages détectés dans votre région',
          timestamp: Date.now()
        });
      }

      if (alerts.length > 0) {
        console.log(`⚠️ ${alerts.length} alerte(s) générée(s)`);
      }

      return alerts;
    } catch (error) {
      console.error('❌ Erreur alertes météo:', error.message);
      return [];
    }
  }
}

const weatherService = new WeatherService(WEATHER_API_KEY);

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API REST
app.get('/api/weather/current/:lat/:lon', async (req, res) => {
  try {
    const { lat, lon } = req.params;
    const weather = await weatherService.getCurrentWeather(parseFloat(lat), parseFloat(lon));
    res.json(weather);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', (req, res) => {
  res.json({
    ...systemStats,
    connectedUsers: connectedUsers.size,
    uptime: Date.now() - systemStats.startTime,
    cacheSize: weatherService.cache.size
  });
});

// Health check pour Render
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    connections: connectedUsers.size
  });
});

// Middleware Socket.IO
io.use((socket, next) => {
  const sessionID = socket.handshake.auth.sessionID || uuidv4();
  const username = socket.handshake.auth.username || `Utilisateur${Math.floor(Math.random() * 1000)}`;
  
  socket.sessionID = sessionID;
  socket.username = username;
  next();
});

// Gestion des connexions WebSocket
io.on('connection', (socket) => {
  console.log(`🔌 Nouvelle connexion: ${socket.username} (${socket.id})`);
  
  systemStats.totalConnections++;
  
  // Enregistrer l'utilisateur
  connectedUsers.set(socket.id, {
    id: socket.id,
    username: socket.username,
    sessionID: socket.sessionID,
    location: null,
    lastWeatherUpdate: null,
    connectedAt: Date.now()
  });

  // Envoyer les infos de session
  socket.emit('session_established', {
    sessionID: socket.sessionID,
    userID: socket.id,
    username: socket.username
  });

  // Envoyer les statistiques
  socket.emit('system_stats', {
    ...systemStats,
    connectedUsers: connectedUsers.size,
    uptime: Date.now() - systemStats.startTime
  });

  // Demander la géolocalisation
  socket.emit('request_location');

  // Gestion de la géolocalisation
  socket.on('location_update', async (locationData) => {
    try {
      const user = connectedUsers.get(socket.id);
      if (user) {
        user.location = locationData;
        user.lastWeatherUpdate = Date.now();
        
        console.log(`📍 Position reçue de ${socket.username}: ${locationData.lat}, ${locationData.lon}`);
        
        // Récupérer données météo
        const [weatherData, forecast, alerts] = await Promise.all([
          weatherService.getCurrentWeather(locationData.lat, locationData.lon),
          weatherService.getForecast(locationData.lat, locationData.lon),
          weatherService.getWeatherAlerts(locationData.lat, locationData.lon)
        ]);

        // Envoyer les données
        socket.emit('weather_update', weatherData);
        socket.emit('forecast_update', forecast);
        
        if (alerts.length > 0) {
          socket.emit('weather_alerts', alerts);
          systemStats.alertsSent += alerts.length;
        }

        // Cache utilisateur
        weatherCache.set(socket.id, {
          weather: weatherData,
          forecast: forecast,
          alerts: alerts,
          timestamp: Date.now()
        });

        systemStats.lastUpdate = Date.now();
        
        // Broadcast stats update
        io.emit('stats_update', {
          connectedUsers: connectedUsers.size,
          totalConnections: systemStats.totalConnections,
          totalWeatherRequests: systemStats.totalWeatherRequests,
          alertsSent: systemStats.alertsSent
        });
      }
    } catch (error) {
      console.error(`❌ Erreur météo pour ${socket.username}:`, error.message);
      socket.emit('weather_error', {
        message: 'Erreur lors de la récupération des données météo',
        error: error.message
      });
    }
  });

  // Rafraîchissement manuel
  socket.on('refresh_weather', async () => {
    const user = connectedUsers.get(socket.id);
    if (user && user.location) {
      console.log(`🔄 Rafraîchissement demandé par ${socket.username}`);
      socket.emit('location_update', user.location);
    } else {
      socket.emit('request_location');
    }
  });

  // Partage météo
  socket.on('share_weather', (data) => {
    console.log(`📤 Partage météo par ${socket.username}`);
    socket.broadcast.emit('shared_weather', {
      from: socket.username,
      location: data.location,
      weather: data.weather,
      timestamp: Date.now()
    });
  });

  // Déconnexion
  socket.on('disconnect', (reason) => {
    console.log(`🔌 Déconnexion: ${socket.username} (${reason})`);
    
    connectedUsers.delete(socket.id);
    weatherCache.delete(socket.id);
    
    socket.broadcast.emit('user_disconnected', {
      username: socket.username,
      reason: reason,
      timestamp: Date.now()
    });
    
    // Mise à jour stats
    io.emit('stats_update', {
      connectedUsers: connectedUsers.size,
      totalConnections: systemStats.totalConnections,
      totalWeatherRequests: systemStats.totalWeatherRequests
    });
  });
});

// Mise à jour automatique toutes les 10 minutes
cron.schedule('*/10 * * * *', async () => {
  if (connectedUsers.size === 0) return;
  
  console.log(`🔄 Mise à jour automatique pour ${connectedUsers.size} utilisateur(s)`);
  
  for (const [socketId, user] of connectedUsers) {
    if (user.location) {
      try {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          const weatherData = await weatherService.getCurrentWeather(
            user.location.lat, 
            user.location.lon
          );
          
          socket.emit('weather_update', weatherData);
          
          const alerts = await weatherService.getWeatherAlerts(
            user.location.lat, 
            user.location.lon
          );
          
          if (alerts.length > 0) {
            socket.emit('weather_alerts', alerts);
            systemStats.alertsSent += alerts.length;
          }
        }
      } catch (error) {
        console.error(`❌ Erreur mise à jour auto pour ${user.username}:`, error.message);
      }
    }
  }
  
  systemStats.lastUpdate = Date.now();
});

// Nettoyage cache toutes les heures
cron.schedule('0 * * * *', () => {
  console.log('🧹 Nettoyage du cache météo...');
  weatherService.cache.clear();
  console.log('✅ Cache nettoyé');
});

// Démarrage du serveur
server.listen(PORT, () => {
  console.log('🌤️ ==========================================');
  console.log(`🚀 Serveur météo WebSocket démarré`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔑 Clé API: ${WEATHER_API_KEY ? 'Configurée ✅' : 'MANQUANTE ❌'}`);
  console.log(`🌍 URL: http://localhost:${PORT}`);
  console.log('🌤️ ==========================================');
});

// Arrêt gracieux
process.on('SIGINT', () => {
  console.log('\n🛑 Arrêt du serveur météo...');
  server.close(() => {
    console.log('✅ Serveur fermé proprement');
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  console.error('❌ Erreur critique:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesse rejetée:', reason);
});