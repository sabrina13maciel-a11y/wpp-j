const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./storage/db');
const authService = require('./services/authService');

const webhookRoutes = require('./routes/webhook');
const uazapiWebhookRoutes = require('./routes/uazapiWebhook');
const apiRoutes = require('./routes/api');
const campaignRoutes = require('./routes/campaignRoutes');
const domainRoutes = require('./routes/domainRoutes');
const { startUazapiMessageSyncWorker } = require('./services/uazapiPoller');

const app = express();

// Habilita trust proxy para Railway e proxies reversos
app.set('trust proxy', true);

// Middlewares globais
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Prevenir cache agressivo do navegador para scripts, páginas e estilos
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css') || req.path === '/' || req.path === '/login') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
// - /generated: Fotos geradas baixadas pelo WhatsApp e Leona
// - /assets: Templates e mídias estáticas do sistema
// - /css: Estilos compartilhados para a tela de login
// - /webhook: Endpoint oficial da Meta WhatsApp Cloud API
// - /api/webhooks/uazapi: Endpoint oficial da uazapi Webhook
// - /c: Endpoint de links curtos de campanha do TikTok Ads
app.use('/generated', express.static(path.join(__dirname, '../public/generated')));
app.use('/assets', express.static(path.join(__dirname, '../assets')));
app.use('/css', express.static(path.join(__dirname, '../public/css')));
app.use('/webhook', webhookRoutes);
app.use('/api/webhooks', uazapiWebhookRoutes);
app.use('/c', campaignRoutes);

// Rota da Tela de Login (se já estiver autenticado, vai direto para o dashboard)
app.get(['/login', '/login.html'], (req, res) => {
  const cookies = authService.parseCookies(req);
  const token = cookies.auth_token;
  if (authService.verifyToken(token)) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

// 2. MIDDLEWARE DE PROTEÇÃO POR SENHA (BARREIRA DE SEGURANÇA)
app.use((req, res, next) => {
  // Rotas que dispensam autenticação:
  // - /c/* (Links de campanha TikTok Ads)
  // - /api/auth/* (login e verificação)
  // - /api/generate-proof (utilizada pela Leona síncrona para gerar as provas)
  if (
    req.path.startsWith('/c/') ||
    req.path.startsWith('/api/auth/') ||
    req.path.startsWith('/api/webhooks/') ||
    req.path.startsWith('/api/generate-proof') ||
    req.path.startsWith('/api/gerar-foto') ||
    req.path.startsWith('/api/webhooks') ||
    req.path.startsWith('/generate-proof') ||
    req.path.startsWith('/gerar-foto') ||
    req.path === '/api/facebook/connect' ||
    req.path === '/favicon.ico'
  ) {
    return next();
  }

  // Extrai token do cookie auth_token ou do header Authorization Bearer
  const cookies = authService.parseCookies(req);
  const token = cookies.auth_token || (req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null);
  const session = authService.verifyToken(token);

  if (session) {
    req.user = session;
    return next();
  }

  // Caso NÃO esteja autenticado:
  // 1) Se for chamada de API: retorna 401 JSON
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Acesso restrito. Faça login para continuar.' });
  }

  // 2) Se for acesso via navegador (HTML/página): redireciona para a tela de login
  return res.redirect('/login');
});

// 3. ROTAS PROTEGIDAS (DISPONÍVEIS APENAS APÓS LOGIN)
app.use('/api', apiRoutes);
app.use('/api/dominios', domainRoutes);

// Prevenir cache agressivo do navegador para scripts, páginas e estilos
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css') || req.path === '/' || req.path === '') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Servir frontend do dashboard e scripts protegidos
app.use(express.static(path.join(__dirname, '../public')));

// Fallback SPA protegido
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Inicialização do servidor
const settings = db.getSettings();
const PORT = process.env.PORT || settings.serverPort || 3000;

app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🚀 WHATSAPP AUTOMATION HUB RODANDO COM SUCESSO!`);
  console.log(`🌐 Dashboard (Protegido): http://localhost:${PORT}`);
  console.log(`🔐 Login: http://localhost:${PORT}/login`);
  console.log(`📡 Webhook Meta (Público): http://localhost:${PORT}/webhook`);
  console.log(`⚡ API Leona (Público): http://localhost:${PORT}/api/generate-proof`);
  console.log('====================================================');

  // Auto-restaura conexão do WhatsApp com a uazapi no boot apenas se estiver habilitado
  const currentSettings = db.getSettings();
  if (currentSettings.uazapiEnabled !== false && typeof apiRoutes.autoRestoreUazapiInstances === 'function') {
    apiRoutes.autoRestoreUazapiInstances().then(instances => {
      const connected = (instances || []).find(i => i.status === 'connected');
      if (connected) {
        console.log(`[Boot] ✓ Conexão WhatsApp preservada e ativa: ${connected.name} (${connected.numero_conectado || connected.id})`);
      }
      startUazapiMessageSyncWorker(3500);
    }).catch(e => {
      console.warn('[Boot] Aviso ao restaurar conexão:', e.message);
      startUazapiMessageSyncWorker(3500);
    });
  } else {
    console.log('[Boot] 📱 Conexão Uazapi desativada. Operando exclusivamente com Meta WhatsApp Cloud API.');
  }
});
