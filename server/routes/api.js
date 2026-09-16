const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../storage/db');
const { composeProofImage } = require('../services/imageComposer');
const { processIncomingMessage, lookupProfilePicture, triggerManualFlow, eventBus } = require('../services/flowEngine');
const metaService = require('../services/metaService');
const tiktokService = require('../services/tiktokService');
const authService = require('../services/authService');
const uazapiService = require('../services/uazapiService');
const cryptoService = require('../services/cryptoService');

// Credenciais permanentes padrão do servidor uazapi
const DEFAULT_UAZAPI_SERVER = 'https://whatsblin.uazapi.com';
const DEFAULT_UAZAPI_ADMIN_TOKEN = 'Wx0bdo99r3VtcDwC8ulQezVLNDY7rcFOzSWgyS7Q9vjWwKKMJp';

/**
 * =========================================================================
 * AUTENTICAÇÃO DO PAINEL
 * =========================================================================
 */
router.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Usuário e senha são obrigatórios' });
  }

  const isValid = authService.validateCredentials(username, password);
  if (!isValid) {
    return res.status(401).json({ success: false, error: 'Usuário ou senha incorretos' });
  }

  const token = authService.generateToken(username);
  
  // Define o cookie auth_token HttpOnly seguro por 7 dias
  res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);

  res.json({
    success: true,
    token,
    user: { username }
  });
});

router.get('/auth/check', (req, res) => {
  const cookies = authService.parseCookies(req);
  const token = cookies.auth_token || (req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null);
  const session = authService.verifyToken(token);

  if (session) {
    return res.json({ authenticated: true, username: session.username });
  }
  res.json({ authenticated: false });
});

router.post('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ success: true });
});

router.post('/auth/change-credentials', (req, res) => {
  const { newUsername, newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'A nova senha deve ter no mínimo 4 caracteres' });
  }
  const updated = authService.updateCredentials(newUsername, newPassword);
  res.json({ success: true, message: 'Credenciais atualizadas com sucesso', username: updated.username });
});

/**
 * Estatísticas Gerais (Visão Geral)
 */
router.get('/stats', (req, res) => {
  const instances = db.getInstances();
  const chats = db.getChats();
  const chatList = Object.values(chats);

  const totalLeads = chatList.length;
  const totalProofsSent = chatList.filter(c => c.state === 'PROPOSTA_ENVIADA' || c.state === 'NEGOCIACAO').length;
  const totalActiveChips = instances.filter(i => i.status === 'connected').length;

  res.json({
    totalLeads,
    totalProofsSent,
    totalActiveChips,
    conversionRate: totalLeads > 0 ? Math.round((totalProofsSent / totalLeads) * 100) : 0
  });
});

/**
 * Helper para construir a URL pública do Webhook para registro na uazapi
 */
function getPublicWebhookUrl(req, instanceId = '') {
  const settings = db.getSettings();
  let base = '';

  if (settings.webhookBaseUrl && String(settings.webhookBaseUrl).startsWith('http')) {
    base = settings.webhookBaseUrl.replace(/\/+$/, '');
  } else {
    let host = req ? (req.get('x-forwarded-host') || req.get('host') || '') : '';
    let proto = req ? (req.get('x-forwarded-proto') || req.protocol || 'https') : 'https';
    if (proto.includes(',')) proto = proto.split(',')[0].trim();

    if (!host || host.includes('localhost') || host.includes('127.0.0.1')) {
      if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        host = process.env.RAILWAY_PUBLIC_DOMAIN;
        proto = 'https';
      } else if (process.env.RAILWAY_STATIC_URL) {
        host = process.env.RAILWAY_STATIC_URL;
        proto = 'https';
      } else if (settings.lastKnownPublicBaseUrl) {
        base = settings.lastKnownPublicBaseUrl.replace(/\/+$/, '');
      }
    }

    if (!base) {
      if (host.includes('railway.app') || host.includes('herokuapp.com') || host.includes('vercel.app') || (!host.includes('localhost') && !host.includes('127.0.0.1') && host.length > 0)) {
        proto = 'https';
      }
      if (!host) {
        host = 'localhost:3000';
        proto = 'http';
      }
      base = `${proto}://${host}`;
      if (!host.includes('localhost') && !host.includes('127.0.0.1')) {
        settings.lastKnownPublicBaseUrl = base;
        db.saveSettings(settings);
      }
    }
  }

  const cleanBase = base.replace(/\/+$/, '');
  return instanceId ? `${cleanBase}/api/webhooks/uazapi?instanceId=${encodeURIComponent(instanceId)}` : `${cleanBase}/api/webhooks/uazapi`;
}

/**
 * Helpers para extração flexível e robusta de dados de conexão da uazapi / Baileys
 */
function extractQrCode(primaryObj, fallbackObj) {
  const getVal = (obj) => {
    if (!obj) return null;
    return obj.qrcode || 
           obj.instance?.qrcode || 
           obj.base64 || 
           obj.instance?.base64 || 
           obj.qr || 
           obj.instance?.qr || 
           (typeof obj.status === 'object' ? (obj.status?.qrcode || obj.status?.base64) : null) || 
           null;
  };
  return getVal(primaryObj) || getVal(fallbackObj) || null;
}

function extractPairCode(primaryObj, fallbackObj) {
  const getVal = (obj) => {
    if (!obj) return null;
    return obj.paircode || 
           obj.instance?.paircode || 
           (typeof obj.status === 'object' ? obj.status?.paircode : null) || 
           null;
  };
  return getVal(primaryObj) || getVal(fallbackObj) || null;
}

function extractConnectedUser(statusRes, connectRes) {
  // 1. Objeto jid.user
  if (statusRes?.status?.jid?.user) return String(statusRes.status.jid.user).replace(/\D/g, '');
  if (statusRes?.jid?.user) return String(statusRes.jid.user).replace(/\D/g, '');
  if (connectRes?.status?.jid?.user) return String(connectRes.status.jid.user).replace(/\D/g, '');
  if (connectRes?.jid?.user) return String(connectRes.jid.user).replace(/\D/g, '');

  // 2. String jid (ex: "5511999999999@s.whatsapp.net" ou "5511999999999:1@s.whatsapp.net")
  const rawJid = (typeof statusRes?.status?.jid === 'string' ? statusRes.status.jid : '') ||
                 (typeof statusRes?.jid === 'string' ? statusRes.jid : '') ||
                 (typeof connectRes?.jid === 'string' ? connectRes.jid : '');
  if (rawJid) {
    const clean = rawJid.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (clean.length >= 8) return clean;
  }

  // 3. owner da instância (campo oficial da uazapi OpenAPI spec: owner)
  const rawOwner = statusRes?.instance?.owner || statusRes?.owner || connectRes?.instance?.owner;
  if (rawOwner) {
    const clean = String(rawOwner).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (clean.length >= 8) return clean;
  }

  // 4. Campos diretos de telefone
  const directPhone = statusRes?.instance?.numero_conectado || 
                      statusRes?.numero_conectado || 
                      statusRes?.instance?.phoneNumber ||
                      statusRes?.phoneNumber ||
                      connectRes?.instance?.numero_conectado;
  if (directPhone) {
    const clean = String(directPhone).replace(/\D/g, '');
    if (clean.length >= 8) return clean;
  }

  // 5. Fallback para profileName se disponível
  if (statusRes?.instance?.profileName) {
    return statusRes.instance.profileName;
  }

  return null;
}

function checkIsConnected(statusRes, connectRes) {
  if (!statusRes && !connectRes) return false;

  const instanceStatus = String(statusRes?.instance?.status || connectRes?.instance?.status || '').toLowerCase();
  const rawStatus = typeof statusRes?.status === 'string' ? statusRes.status.toLowerCase() : '';
  const objStatus = typeof statusRes?.status === 'object' ? statusRes.status : {};

  // Se houver qualquer indicador explícito de desconexão, NÃO está conectado
  if (
    instanceStatus === 'disconnected' || instanceStatus === 'close' || instanceStatus === 'closed' ||
    rawStatus === 'disconnected' || rawStatus === 'close' || rawStatus === 'closed' ||
    objStatus?.connected === false || statusRes?.connected === false || connectRes?.connected === false ||
    objStatus?.loggedIn === false || statusRes?.loggedIn === false
  ) {
    return false;
  }

  return Boolean(
    instanceStatus === 'connected' ||
    rawStatus === 'connected' ||
    objStatus?.connected === true ||
    statusRes?.connected === true ||
    connectRes?.connected === true ||
    (objStatus?.loggedIn === true && objStatus?.connected !== false)
  );
}

/**
 * Sincroniza dados e status da instância uazapi e reconfigura webhook
 */
async function syncUazapiInstanceData(inst, req = null) {
  if (!inst || inst.tipo !== 'uazapi' || !inst.instance_token) return false;
  try {
    const decToken = cryptoService.decrypt(inst.instance_token);
    const statusRes = await uazapiService.getInstanceStatus(inst.url_servidor, decToken);
    const isConnected = checkIsConnected(statusRes, null);
    const connectedUser = extractConnectedUser(statusRes, null);

    inst.lastSyncedAt = new Date().toISOString();

    if (isConnected) {
      const wasConnected = inst.status === 'connected';
      inst.status = 'connected';
      if (connectedUser && /\d{8,}/.test(connectedUser)) {
        inst.numero_conectado = connectedUser;
        inst.phoneNumber = connectedUser;
      }
      db.saveInstance(inst);

      // Garante que o Webhook está configurado na uazapi com URL pública
      try {
        const webhookUrl = getPublicWebhookUrl(req, inst.id);
        await uazapiService.configureWebhook(inst.url_servidor, decToken, webhookUrl);
        console.log(`[uazapi Sync] ✓ Webhook ativo para ${inst.name}: ${webhookUrl}`);
      } catch (wErr) {
        console.warn(`[uazapi Sync] Aviso ao configurar webhook para ${inst.name}:`, wErr.message);
      }

      if (!wasConnected) {
        eventBus.emit('instances_updated', { instanceId: inst.id, status: 'connected' });
        // Auto-sincroniza conversas existentes ao conectar
        syncChatsFromUazapi(inst).catch(cErr => console.warn('[uazapi Chat Sync Auto Error]', cErr.message));
      }
      return !wasConnected;
    } else {
      // NÃO está conectado
      const isConnecting = statusRes?.status === 'connecting' || 
                           statusRes?.instance?.status === 'connecting' || 
                           Boolean(statusRes?.qrcode || statusRes?.status?.qrcode || statusRes?.paircode || statusRes?.status?.paircode);
      const newStatus = isConnecting ? 'connecting' : 'disconnected';
      const changed = inst.status !== newStatus;
      inst.status = newStatus;
      db.saveInstance(inst);
      if (changed) {
        console.log(`[uazapi Sync] ⚠️ Instância ${inst.name} (${inst.id}) atualizada para "${newStatus}".`);
        eventBus.emit('instances_updated', { instanceId: inst.id, status: newStatus });
      }
      return changed;
    }
  } catch (err) {
    console.warn(`[uazapi Sync Error] Falha ao consultar uazapi para ${inst.name}:`, err.message);
    const isAuthOrNotFound = err.details?.status === 401 || err.details?.status === 404 || 
                             err.message?.includes('401') || err.message?.includes('404') ||
                             err.code === 'UNAUTHORIZED' || err.code === 'NOT_FOUND';
    if (isAuthOrNotFound) {
      if (inst.status !== 'disconnected') {
        console.log(`[uazapi Sync] ⚠️ Instância ${inst.name} (${inst.id}) com token inválido/expirado (401/404). Marcando como desconectada.`);
        inst.status = 'disconnected';
        db.saveInstance(inst);
        eventBus.emit('instances_updated', { instanceId: inst.id, status: 'disconnected' });
        return true;
      }
    }
  }
  return false;
}

function parseUazapiTimestamp(ts) {
  if (!ts) return new Date().toISOString();
  const num = Number(ts);
  if (isNaN(num)) return new Date().toISOString();
  const ms = num > 1e11 ? num : num * 1000;
  return new Date(ms).toISOString();
}

/**
 * Sincroniza conversas e mensagens existentes da uazapi para o banco local
 */
async function syncChatsFromUazapi(inst) {
  if (!inst || inst.tipo !== 'uazapi' || !inst.instance_token) return { importedChats: 0, importedMessages: 0 };
  try {
    const decToken = cryptoService.decrypt(inst.instance_token);
    const chats = await uazapiService.findChats(inst.url_servidor, decToken, 30);
    if (!Array.isArray(chats) || chats.length === 0) return { importedChats: 0, importedMessages: 0 };

    let importedChats = 0;
    let importedMessages = 0;
    const allChats = db.getChats();

    for (const c of chats) {
      if (!c.wa_chatid || c.wa_isGroup) continue;
      const cleanPhone = String(c.wa_chatid).split('@')[0].replace(/\D/g, '');
      if (!cleanPhone || cleanPhone.length < 8) continue;

      const leadName = c.name || c.wa_name || c.wa_contactName || `Lead +${cleanPhone}`;

      if (!allChats[cleanPhone]) {
        allChats[cleanPhone] = {
          leadPhone: cleanPhone,
          leadName,
          instanceId: inst.id,
          state: 'NOVO',
          lastMessageTime: parseUazapiTimestamp(c.wa_lastMsgTimestamp),
          messages: []
        };
        importedChats++;
      } else if (c.name && (!allChats[cleanPhone].leadName || allChats[cleanPhone].leadName.startsWith('Lead '))) {
        allChats[cleanPhone].leadName = leadName;
      }

      // Busca mensagens recentes desta conversa e sincroniza qualquer mensagem faltante
      try {
        const msgs = await uazapiService.findMessages(inst.url_servidor, decToken, c.wa_chatid, 25);
        if (Array.isArray(msgs)) {
          msgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
          for (const m of msgs) {
            const msgId = m.id || m.messageid || `${cleanPhone}_${m.messageTimestamp}`;
            const exists = allChats[cleanPhone].messages.some(existing => existing.id === msgId);
            if (!exists) {
              const text = (m.text || m.body || m.content?.text || (typeof m.content === 'string' ? m.content : '') || m.message?.conversation || '').trim();
              if (text || m.fileURL) {
                allChats[cleanPhone].messages.push({
                  id: msgId,
                  timestamp: parseUazapiTimestamp(m.messageTimestamp || m.timestamp),
                  from: m.fromMe ? 'agent' : 'lead',
                  text: text || '[Mídia]',
                  mediaUrl: m.fileURL || null,
                  mediaType: m.messageType || null,
                  instanceId: inst.id
                });
                importedMessages++;
              }
            }
          }
        }
      } catch (mErr) {}
    }

    db.saveChats(allChats);
    eventBus.emit('chat_updated', { total: Object.keys(allChats).length });
    return { importedChats, importedMessages };
  } catch (err) {
    console.warn(`[uazapi Chat Sync Error]`, err.message);
    return { importedChats: 0, importedMessages: 0 };
  }
}

/**
 * Restaura automaticamente conexões uazapi do servidor oficial caso a base local esteja vazia
 */
async function autoRestoreUazapiInstances(req = null) {
  try {
    const settings = db.getSettings();
    if (settings.uazapiEnabled === false) return db.getInstances();
    const serverUrl = process.env.UAZAPI_SERVER_URL || settings?.uazapi?.serverUrl || DEFAULT_UAZAPI_SERVER;
    const adminToken = process.env.UAZAPI_ADMIN_TOKEN || settings?.uazapi?.adminToken || settings?.uazapiAdminToken || DEFAULT_UAZAPI_ADMIN_TOKEN;

    if (!adminToken) return db.getInstances();

    const remoteInstances = await uazapiService.fetchAllInstances(serverUrl, adminToken);
    if (!Array.isArray(remoteInstances)) return db.getInstances();

    let restoredAny = false;
    let localInstances = db.getInstances();

    const remoteIdSet = new Set(remoteInstances.map(r => r.id));

    // 1. Limpa instâncias locais uazapi que não existem mais remotamente na uazapi
    for (const loc of localInstances) {
      if (loc.tipo === 'uazapi' && loc.instance_id) {
        if (!remoteIdSet.has(loc.instance_id)) {
          console.log(`[Auto-Restore] 🗑️ Removendo instância local que não existe mais na uazapi: "${loc.name}" (${loc.id})`);
          db.deleteInstance(loc.id);
          restoredAny = true;
        }
      }
    }

    localInstances = db.getInstances();

    // 2. Sincroniza instâncias remotas (novas ou existentes)
    for (const rem of remoteInstances) {
      if (!rem.token) continue;
      // Ignora tentativas antigas de QR Code que expiraram sem nunca conectar e sem nome/dono
      if (rem.status === 'disconnected' && !rem.owner && !rem.profileName) continue;

      const cleanOwner = rem.owner ? String(rem.owner).replace(/@.*$/, '').replace(/\D/g, '') : '';
      const existing = localInstances.find(i => i.instance_id === rem.id || i.id === `uaz_${rem.id}`);

      if (!existing) {
        console.log(`[Auto-Restore] 🔄 Restaurando nova instância conectada da uazapi "${rem.name || rem.id}" (${rem.status})...`);
        const newInst = {
          id: `uaz_${rem.id}`,
          name: rem.name || '01',
          tipo: 'uazapi',
          url_servidor: serverUrl,
          instance_id: rem.id,
          instance_token: cryptoService.encrypt(rem.token),
          phoneNumber: cleanOwner,
          numero_conectado: cleanOwner,
          status: rem.status || 'connected',
          assignedFlowId: 'fluxo-espiao-foto',
          totalSent: 0,
          totalReceived: 0,
          criado_em: rem.created || new Date().toISOString(),
          createdAt: rem.created || new Date().toISOString(),
          lastSyncedAt: new Date().toISOString()
        };
        db.saveInstance(newInst);
        restoredAny = true;

        if (rem.status === 'connected') {
          try {
            const webhookUrl = getPublicWebhookUrl(req, newInst.id);
            await uazapiService.configureWebhook(serverUrl, rem.token, webhookUrl);
            console.log(`[Auto-Restore] ✓ Webhook configurado para ${newInst.name}: ${webhookUrl}`);
          } catch (wErr) {
            console.warn('[Auto-Restore] Aviso webhook:', wErr.message);
          }
          syncChatsFromUazapi(newInst).catch(() => {});
        }
      } else {
        let changed = false;
        const remStatus = rem.status || 'disconnected';
        if (existing.status !== remStatus) {
          existing.status = remStatus;
          changed = true;
        }
        if (cleanOwner && existing.numero_conectado !== cleanOwner) {
          existing.phoneNumber = cleanOwner;
          existing.numero_conectado = cleanOwner;
          changed = true;
        }
        if (rem.name && existing.name !== rem.name) {
          existing.name = rem.name;
          changed = true;
        }
        let currentDecToken = '';
        try { currentDecToken = cryptoService.decrypt(existing.instance_token); } catch(e) {}
        if (rem.token && currentDecToken !== rem.token) {
          existing.instance_token = cryptoService.encrypt(rem.token);
          changed = true;
        }
        if (changed) {
          existing.lastSyncedAt = new Date().toISOString();
          db.saveInstance(existing);
          restoredAny = true;
        }
      }
    }

    if (restoredAny) {
      eventBus.emit('instances_updated', { restored: true });
    }
    return db.getInstances();
  } catch (err) {
    console.warn('[Auto-Restore Error]', err.message);
    return db.getInstances();
  }
}

/**
 * Instâncias / Chips (CRUD)
 * Sincroniza e auto-restaura conexões uazapi para nunca perder status de conexão
 */
router.get('/instances', async (req, res) => {
  // 1. Sincroniza e auto-restaura com a uazapi em todas as requisições do painel
  await autoRestoreUazapiInstances(req);

  let instances = db.getInstances();
  let updatedAny = false;

  // 2. Consulta o status live de cada chip uazapi
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    if (inst.tipo === 'uazapi' && inst.instance_token) {
      const changed = await syncUazapiInstanceData(inst, req);
      if (changed) updatedAny = true;
    }
  }

  if (updatedAny) {
    instances = db.getInstances();
  }

  // Mascara tokens para não expor segredos sensíveis no frontend
  const safe = instances.map(i => {
    const copy = { ...i };
    if (copy.instance_token) {
      copy.hasInstanceToken = true;
      copy.instance_token = '••••••••';
    }
    if (copy.accessToken) {
      copy.hasAccessToken = true;
      copy.accessToken = '••••••••';
    }
    return copy;
  });
  res.json(safe);
});


router.post('/instances', (req, res) => {
  const instances = db.getInstances();
  const { name, phoneNumber, phoneNumberId, wabaId, accessToken, assignedFlowId, tipo, url_servidor } = req.body;

  const newInst = {
    id: req.body.id || `inst_${Date.now()}`,
    name: name || 'Novo Chip',
    tipo: tipo || 'meta',
    url_servidor: url_servidor || '',
    phoneNumber: phoneNumber || '',
    phoneNumberId: phoneNumberId || '',
    wabaId: wabaId || '',
    accessToken: accessToken || '',
    assignedFlowId: assignedFlowId || 'fluxo-espiao-foto',
    status: (accessToken && phoneNumberId) ? 'connected' : 'disconnected',
    totalSent: 0,
    totalReceived: 0,
    createdAt: new Date().toISOString()
  };

  const existingIdx = instances.findIndex(i => i.id === newInst.id);
  if (existingIdx >= 0) {
    instances[existingIdx] = {
      ...instances[existingIdx],
      ...newInst,
      assignedFlowId: assignedFlowId !== undefined ? assignedFlowId : (instances[existingIdx].assignedFlowId || 'fluxo-espiao-foto')
    };
  } else {
    instances.push(newInst);
  }

  db.saveInstances(instances);
  res.json({ success: true, instance: existingIdx >= 0 ? instances[existingIdx] : newInst });
});

router.patch('/instances/:id/flow', (req, res) => {
  const { flowId } = req.body;
  const instances = db.getInstances();
  const inst = instances.find(i => i.id === req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instância / Chip não encontrado' });
  
  inst.assignedFlowId = flowId || 'fluxo-espiao-foto';
  db.saveInstances(instances);
  console.log(`[Instances] Chip ${inst.name} (${inst.id}) vinculado com sucesso ao fluxo: ${inst.assignedFlowId}`);
  res.json({ success: true, instance: inst });
});

router.delete('/instances/:id', async (req, res) => {
  try {
    const rawId = req.params.id;
    let instances = db.getInstances();
    const target = instances.find(i => i.id === rawId || i.instance_id === rawId || `uaz_${i.instance_id}` === rawId || i.name === rawId);

    const settings = db.getSettings() || {};
    const serverUrl = target?.url_servidor || settings?.uazapi?.serverUrl || DEFAULT_UAZAPI_SERVER;
    const adminToken = settings?.uazapi?.adminToken || settings?.uazapiAdminToken || DEFAULT_UAZAPI_ADMIN_TOKEN;

    // 1. Deletar na uazapi pelo token da instância se disponível
    if (target && target.tipo === 'uazapi' && target.instance_token) {
      try {
        const decToken = cryptoService.decrypt(target.instance_token);
        await uazapiService.deleteInstance(serverUrl, decToken);
        console.log(`[Instances] Instância ${target.name} (${target.instance_id}) deletada da uazapi via token.`);
      } catch (e) {
        console.warn('[Instances] Aviso ao deletar uazapi via token:', e.message);
      }
    }

    // 2. Garantia extra na nuvem uazapi: deleta instância remota correspondente
    try {
      const remoteList = await uazapiService.fetchAllInstances(serverUrl, adminToken);
      const targetInstanceId = target?.instance_id || rawId.replace(/^uaz_/, '');
      const matchingRemotes = remoteList.filter(r => r.id === targetInstanceId || (target?.name && r.name === target.name));
      for (const rem of matchingRemotes) {
        if (rem.token) {
          console.log(`[Instances] Removendo instância remota ${rem.id} (${rem.name}) da uazapi...`);
          await uazapiService.deleteInstance(serverUrl, rem.token);
        }
      }
    } catch (remErr) {
      console.warn('[Instances] Aviso ao verificar/remover na uazapi:', remErr.message);
    }

    // 3. Remove definitivamente do banco local (db.js / instances.json)
    db.deleteInstance(rawId);
    if (target) {
      db.deleteInstance(target.id);
      if (target.instance_id) db.deleteInstance(target.instance_id);
    }

    eventBus.emit('instances_updated', { deleted: true, id: rawId });
    res.json({ success: true, message: 'Instância removida com sucesso' });
  } catch (err) {
    console.error('[Delete Instance Error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * =========================================================================
 * ENDPOINTS uazapi (WHATSAPP API WEB)
 * =========================================================================
 */

/**
 * 1. POST /api/uazapi/init-connect
 * Fluxo de inicialização de conexão uazapi:
 * - Credenciais permanentes padrão: whatsblin.uazapi.com
 * - Se fornecida API Key (instanceKey), valida na uazapi
 * - Se não fornecida, busca instância existente ou cria nova
 * - Trata e contorna limites 429 reaproveitando slots desconectados automaticamente
 * - Dispara POST /instance/connect para iniciar socket e geração de QR code
 * - Salva conexão no banco local com status 'connecting'
 * - Retorna QR code, paircode e status real
 */
router.post('/uazapi/init-connect', async (req, res) => {
  try {
    const { name, serverUrl, instanceKey, phone, assignedFlowId, adminToken: inputAdminToken } = req.body;
    const cleanName = (name || 'NOVA').trim();
    const settings = db.getSettings() || {};
    const cleanServerUrl = uazapiService.normalizeServerUrl(serverUrl || settings.uazapi?.serverUrl || settings.uazapiServerUrl || DEFAULT_UAZAPI_SERVER);
    const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;
    const adminToken = (inputAdminToken && String(inputAdminToken).trim()) || settings.uazapi?.adminToken || settings.uazapiAdminToken || process.env.UAZAPI_ADMIN_TOKEN || DEFAULT_UAZAPI_ADMIN_TOKEN;

    let instanceToken = '';
    let instanceId = '';

    // 1. Identifica se usa uma API Key existente ou se precisa resolver/criar na uazapi
    if (instanceKey && String(instanceKey).trim()) {
      instanceToken = String(instanceKey).trim();
      console.log(`[uazapi Init] Validando API Key de instância informada em ${cleanServerUrl}...`);
      
      try {
        const checkStatus = await uazapiService.getInstanceStatus(cleanServerUrl, instanceToken);
        instanceId = checkStatus.instance?.id || `uaz_${Date.now()}`;
        console.log(`[uazapi Init] ✓ API Key válida para instância: ${instanceId}`);
      } catch (err) {
        return res.status(err.details?.status || 400).json({
          success: false,
          error: `Falha ao validar a API Key da instância fornecida: ${err.message}`,
          details: err.details
        });
      }
    } else {
      // 2. Resolução inteligente de instância para EVITAR 429 e limites de plano
      console.log(`[uazapi Init] Resolvendo instância para "${cleanName}" em ${cleanServerUrl}...`);

      let remoteInstances = [];
      try {
        remoteInstances = await uazapiService.fetchAllInstances(cleanServerUrl, adminToken);
      } catch (e) {
        console.warn('[uazapi Init] Aviso ao buscar instâncias remotas:', e.message);
      }

      // 2.1. Verifica se já existe instância com o mesmo nome na uazapi
      const sameNameInst = remoteInstances.find(i => (i.name || '').trim().toLowerCase() === cleanName.toLowerCase());
      if (sameNameInst && sameNameInst.token) {
        console.log(`[uazapi Init] ✓ Instância "${cleanName}" já existe na uazapi (${sameNameInst.id}). Reutilizando com sucesso.`);
        instanceToken = sameNameInst.token;
        instanceId = sameNameInst.id;
      } else {
        // 2.2. Se não existe com o mesmo nome, tenta criar nova instância
        let created = false;
        try {
          const createRes = await uazapiService.createInstance(cleanServerUrl, adminToken, cleanName);
          instanceToken = createRes.token;
          instanceId = createRes.instance?.id || `uaz_${Date.now()}`;
          created = true;
          console.log(`[uazapi Init] ✓ Nova instância criada com sucesso na uazapi! ID: ${instanceId}`);
        } catch (createErr) {
          console.warn(`[uazapi Init] Criação retornou: ${createErr.message}. Analisando reaproveitamento de slot para contornar limite 429...`);

          // 2.3. Se deu erro de limite (429 / Max instances) ou qualquer restrição de criação:
          // Localiza uma instância desconectada existente na conta para reaproveitar o slot
          const disconnectedInst = remoteInstances.find(i => i.status === 'disconnected') || remoteInstances[0];
          if (disconnectedInst && disconnectedInst.token) {
            console.log(`[uazapi Init] ✓ Reutilizando slot da instância ${disconnectedInst.id} (anterior: "${disconnectedInst.name}") para eliminar o limite 429.`);
            instanceToken = disconnectedInst.token;
            instanceId = disconnectedInst.id;

            // Renomeia a instância na uazapi para o nome solicitado
            uazapiService.updateInstanceName(cleanServerUrl, instanceToken, cleanName).catch(renameErr => {
              console.warn(`[uazapi Init] Aviso ao renomear instância: ${renameErr.message}`);
            });
          } else {
            // Se nenhuma instância remota existe, propaga o erro
            throw createErr;
          }
        }
      }
    }

    // 3. Dispara a conexão (inicia geração do QR code ou código de pareamento)
    console.log(`[uazapi Init] Chamando /instance/connect para ${instanceId}...`);
    const connectRes = await uazapiService.connectInstance(cleanServerUrl, instanceToken, { phone: cleanPhone });

    // Pequeno intervalo para a uazapi disponibilizar o QR code no status
    await new Promise(r => setTimeout(r, 650));

    // 3. Obtém o status da instância com o QR code gerado
    let statusRes = null;
    try {
      statusRes = await uazapiService.getInstanceStatus(cleanServerUrl, instanceToken);
    } catch (statusErr) {
      console.warn(`[uazapi Init] Status inicial pós-connect: ${statusErr.message}`);
      statusRes = { status: { connected: false, loggedIn: false } };
    }

    // Identifica se realmente há conexão
    const isFullyConnected = checkIsConnected(statusRes, connectRes);
    const connectedUser = extractConnectedUser(statusRes, connectRes);

    // Extrai QR code e paircode de qualquer campo retornado pela uazapi
    const qrcode = extractQrCode(statusRes, connectRes);
    const paircode = extractPairCode(statusRes, connectRes);

    // Criptografa o token da instância antes de salvar (AES-256-GCM)
    const encryptedToken = cryptoService.encrypt(instanceToken);

    // Persistência na tabela de conexões/instâncias (db.js / instances.json)
    const connectionId = `uaz_${instanceId}`;
    const newConnection = {
      id: connectionId,
      name: cleanName,
      tipo: 'uazapi',
      url_servidor: cleanServerUrl,
      instance_id: instanceId,
      instance_token: encryptedToken,
      phoneNumber: (connectedUser && /\d{8,}/.test(connectedUser)) ? connectedUser : (cleanPhone || ''),
      numero_conectado: connectedUser || '',
      status: isFullyConnected ? 'connected' : 'connecting',
      assignedFlowId: assignedFlowId || 'fluxo-espiao-foto',
      totalSent: 0,
      totalReceived: 0,
      criado_em: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };

    db.saveInstance(newConnection);
    console.log(`[uazapi Init] ✓ Instância salva no sistema local com status: ${newConnection.status}`);

    // Se a instância já estava autenticada anteriormente, ativa o webhook
    if (isFullyConnected) {
      const webhookUrl = getPublicWebhookUrl(req, connectionId);
      uazapiService.configureWebhook(cleanServerUrl, instanceToken, webhookUrl).catch(e => {
        console.warn('[uazapi Init] Aviso ao configurar webhook para instância pré-conectada:', e.message);
      });
    }

    res.json({
      success: true,
      instanceId: connectionId,
      uazapiInstanceId: instanceId,
      qrcode,
      paircode,
      connected: isFullyConnected,
      numero_conectado: connectedUser || '',
      status: statusRes?.status || { connected: isFullyConnected, loggedIn: isFullyConnected }
    });
  } catch (err) {
    console.error('[uazapi Init Error]', err);
    res.status(err.details?.status || 500).json({
      success: false,
      error: err.message || 'Falha ao iniciar conexão com a uazapi',
      details: err.details
    });
  }
});

/**
 * Consulta o status da instância em polling (a cada 2-3s)
 * Se conectada:
 * - Atualiza status no banco para 'connected'
 * - Salva número conectado
 * - Configura automaticamente o webhook na uazapi com events: messages, messages_update, connection, chats
 * - Dispara busca de conversas em segundo plano
 */
router.get('/uazapi/status/:instanceId', async (req, res) => {
  try {
    const inst = db.getInstance(req.params.instanceId);
    if (!inst) {
      return res.status(404).json({ success: false, error: 'Conexão não encontrada no sistema' });
    }

    if (inst.tipo !== 'uazapi') {
      return res.json({
        success: true,
        connected: inst.status === 'connected',
        instance: { id: inst.id, name: inst.name, status: inst.status }
      });
    }

    const decryptedToken = cryptoService.decrypt(inst.instance_token);
    const statusRes = await uazapiService.getInstanceStatus(inst.url_servidor, decryptedToken);

    const isFullyConnected = checkIsConnected(statusRes, null);
    const connectedUser = extractConnectedUser(statusRes, null);

    if (isFullyConnected) {
      const wasConnected = inst.status === 'connected';
      inst.status = 'connected';
      if (connectedUser && /\d{8,}/.test(connectedUser)) {
        inst.numero_conectado = connectedUser;
        inst.phoneNumber = connectedUser;
      }
      db.saveInstance(inst);

      // Configuração automática do Webhook com URL pública + instanceId na query
      try {
        const webhookUrl = getPublicWebhookUrl(req, inst.id);
        await uazapiService.configureWebhook(inst.url_servidor, decryptedToken, webhookUrl);
        console.log(`[uazapi Status] ✓ Webhook configurado com sucesso para ${inst.name}: ${webhookUrl}`);
      } catch (webhookErr) {
        console.warn(`[uazapi Status] Aviso ao configurar webhook: ${webhookErr.message}`);
      }

      if (!wasConnected) {
        eventBus.emit('instances_updated', { instanceId: inst.id, status: 'connected' });
        syncChatsFromUazapi(inst).catch(e => console.warn('[uazapi] Auto-sync chats aviso:', e.message));
      }
    } else {
      if (inst.status !== 'connecting') {
        inst.status = 'connecting';
        db.saveInstance(inst);
      }
    }

    const qrcode = extractQrCode(statusRes, null);
    const paircode = extractPairCode(statusRes, null);

    res.json({
      success: true,
      connected: isFullyConnected,
      loggedIn: isFullyConnected,
      numero_conectado: connectedUser || inst.numero_conectado || '',
      qrcode,
      paircode,
      status: statusRes?.status || {},
      instance: {
        id: inst.id,
        name: inst.name,
        numero_conectado: inst.numero_conectado,
        status: inst.status
      }
    });
  } catch (err) {
    console.error('[uazapi Status Error]', err);
    res.status(err.details?.status || 500).json({
      success: false,
      error: err.message || 'Falha ao consultar status da uazapi',
      details: err.details
    });
  }
});

/**
 * Força sincronização de status e reconfiguração de webhook da uazapi manualmente
 */
router.post('/uazapi/sync/:instanceId', async (req, res) => {
  try {
    const inst = db.getInstance(req.params.instanceId);
    if (!inst) return res.status(404).json({ success: false, error: 'Instância não encontrada' });
    if (inst.tipo !== 'uazapi' || !inst.instance_token) {
      return res.json({ success: true, instance: inst });
    }

    await syncUazapiInstanceData(inst, req);
    const updated = db.getInstance(req.params.instanceId);
    res.json({ success: true, instance: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Força sincronização de conversas e mensagens existentes da uazapi para o banco local
 */
router.post('/uazapi/sync-chats/:instanceId', async (req, res) => {
  try {
    const inst = db.getInstance(req.params.instanceId) || db.getInstances().find(i => i.tipo === 'uazapi' && i.status === 'connected');
    if (!inst) return res.status(404).json({ success: false, error: 'Instância conectada não encontrada' });

    const result = await syncChatsFromUazapi(inst);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Renovação automática do QR Code quando atingir o timeout de 2 minutos
 */
router.post('/uazapi/refresh-qr/:instanceId', async (req, res) => {
  try {
    const inst = db.getInstance(req.params.instanceId);
    if (!inst || inst.tipo !== 'uazapi') {
      return res.status(404).json({ success: false, error: 'Instância uazapi não encontrada' });
    }

    const decryptedToken = cryptoService.decrypt(inst.instance_token);
    console.log(`[uazapi Refresh] Renovando QR Code após timeout de 2 minutos para ${inst.name}...`);
    
    // Dispara nova conexão para gerar QR Code novo
    const connectRes = await uazapiService.connectInstance(inst.url_servidor, decryptedToken);
    await new Promise(r => setTimeout(r, 650));
    
    const statusRes = await uazapiService.getInstanceStatus(inst.url_servidor, decryptedToken);

    const isFullyConnected = checkIsConnected(statusRes, connectRes);
    const connectedUser = extractConnectedUser(statusRes, connectRes);

    const qrcode = extractQrCode(statusRes, connectRes);
    const paircode = extractPairCode(statusRes, connectRes);

    res.json({
      success: true,
      qrcode,
      paircode,
      connected: isFullyConnected,
      status: statusRes?.status || {}
    });
  } catch (err) {
    console.error('[uazapi Refresh Error]', err);
    res.status(err.details?.status || 500).json({
      success: false,
      error: err.message || 'Falha ao renovar QR Code da uazapi',
      details: err.details
    });
  }
});

/**
 * Live Chat (Inbox)
 */
router.get('/chats', async (req, res) => {
  try {
    const existing = db.getChats() || {};
    if (Object.keys(existing).length === 0) {
      const instances = db.getInstances();
      const connectedInst = instances.find(i => i.tipo === 'uazapi' && i.status === 'connected' && i.instance_token);
      if (connectedInst) {
        await syncChatsFromUazapi(connectedInst);
      }
    }
  } catch (e) {
    console.warn('[Chats Sync on Fetch Warning]', e.message);
  }
  res.json(db.getChats());
});

router.get('/chats/:phone', (req, res) => {
  const chats = db.getChats();
  const chat = chats[req.params.phone];
  if (!chat) return res.status(404).json({ error: 'Chat não encontrado' });
  res.json(chat);
});

router.post('/chats/:phone/send', async (req, res) => {
  const { text } = req.body;
  const phone = req.params.phone;
  const chats = db.getChats();
  const chat = chats[phone];

  if (!text) return res.status(400).json({ error: 'Texto obrigatório' });

  const instances = db.getInstances();
  const instance = instances.find(i => i.id === chat?.instanceId) ||
                   instances.find(i => i.tipo === 'uazapi' && i.status === 'connected') ||
                   instances.find(i => i.status === 'connected') ||
                   instances[0] || {};

  const { newMessage } = db.addChatMessage(phone, {
    from: 'agent',
    text,
    instanceId: instance.id
  });

  // Envia a mensagem dependendo do tipo da conexão (uazapi ou Meta)
  if (instance.tipo === 'uazapi' && instance.instance_token) {
    try {
      const decToken = cryptoService.decrypt(instance.instance_token);
      await uazapiService.sendTextMessage(instance.url_servidor, decToken, phone, text);
    } catch (e) {
      console.error('[API Send] Falha ao enviar texto via uazapi:', e.message);
    }
  } else if (instance.accessToken && instance.phoneNumberId) {
    await metaService.sendTextMessage(instance.phoneNumberId, instance.accessToken, phone, text);
  }

  eventBus.emit('new_message', { phone, message: newMessage });
  res.json({ success: true, message: newMessage });
});

/**
 * Disparo manual de fluxo para um contato por dentro do Chat ao Vivo
 */
router.post('/chats/:phone/trigger-flow', async (req, res) => {
  try {
    const { flowId, step, instanceId } = req.body || {};
    const phone = req.params.phone;
    const result = await triggerManualFlow(phone, { flowId, step, instanceId });
    res.json(result);
  } catch (err) {
    console.error('[Trigger Flow Error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Reseta o estado de um lead para NOVO
 */
router.post('/chats/:phone/reset-state', async (req, res) => {
  try {
    const phone = req.params.phone;
    const chats = db.getChats();
    if (chats[phone]) {
      chats[phone].state = 'NOVO';
      chats[phone].upsellStage = 'stage_49';
      chats[phone].currentNodeId = null;
      db.saveChats(chats);
      eventBus.emit('chat_updated', { phone });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Configurações do Funil
 */
router.get('/funnel', (req, res) => {
  res.json(db.getFunnel());
});

router.post('/funnel', (req, res) => {
  const funnel = { ...db.getFunnel(), ...req.body };
  db.saveFunnel(funnel);
  res.json({ success: true, funnel });
});

/**
 * Configurações Gerais e Chaves
 */
router.get('/settings', (req, res) => {
  const settings = { ...db.getSettings() };
  if (settings.openaiApiKey) {
    settings.openaiApiKey = cryptoService.decrypt(settings.openaiApiKey);
  }
  res.json(settings);
});

router.post('/settings', (req, res) => {
  const body = { ...req.body };
  if (body.openaiApiKey && typeof body.openaiApiKey === 'string') {
    body.openaiApiKey = cryptoService.encrypt(body.openaiApiKey.trim());
  }
  const settings = { ...db.getSettings(), ...body };
  db.saveSettings(settings);
  const returnedSettings = { ...settings };
  if (returnedSettings.openaiApiKey) {
    returnedSettings.openaiApiKey = cryptoService.decrypt(returnedSettings.openaiApiKey);
  }
  res.json({ success: true, settings: returnedSettings });
});

/**
 * Gestão de Fluxos (Canvas e Lista)
 */
router.get('/flows', (req, res) => {
  res.json(db.getFlows());
});

router.get('/flows/:id', (req, res) => {
  const flow = db.getFlow(req.params.id);
  if (!flow) return res.status(404).json({ error: 'Fluxo não encontrado' });
  res.json(flow);
});

router.post('/flows', (req, res) => {
  const { name, description } = req.body;
  const newFlow = {
    id: 'fluxo-' + Date.now(),
    name: name || 'Novo Fluxo Sem Título',
    description: description || 'Fluxo de atendimento automatizado',
    status: 'ativo',
    blocksCount: 1,
    updatedAt: new Date().toISOString(),
    nodes: [
      {
        id: 'node-start',
        type: 'trigger',
        label: 'Início (Gatilho)',
        icon: '⚡',
        color: 'green',
        x: 100,
        y: 200,
        data: { text: 'Cliente enviou primeira mensagem' }
      }
    ],
    edges: []
  };
  db.saveFlow(newFlow.id, newFlow);
  res.json({ success: true, flow: newFlow });
});

router.put('/flows/:id', (req, res) => {
  const flow = db.saveFlow(req.params.id, req.body);
  res.json({ success: true, flow });
});

router.delete('/flows/:id', (req, res) => {
  let flows = db.getFlows();
  flows = flows.filter(f => f.id !== req.params.id);
  db.saveFlows(flows);
  res.json({ success: true });
});

router.post('/flows/:id/duplicate', (req, res) => {
  const flow = db.getFlow(req.params.id);
  if (!flow) return res.status(404).json({ error: 'Fluxo não encontrado' });

  const duplicated = {
    ...flow,
    id: 'fluxo-copy-' + Date.now(),
    name: `${flow.name} (Cópia)`,
    updatedAt: new Date().toISOString()
  };
  db.saveFlow(duplicated.id, duplicated);
  res.json({ success: true, flow: duplicated });
});

/**
 * Kanban CRM
 */
router.get('/kanban', (req, res) => {
  const chats = db.getChats();
  const list = Object.values(chats);

  const columns = {
    novos: { title: 'Novo Lead', leads: [] },
    aguardando: { title: 'Aguardando Número', leads: [] },
    analise: { title: 'Em Análise / Foto', leads: [] },
    proposta: { title: 'Proposta Enviada', leads: [] },
    pago: { title: 'Venda Aprovada', leads: [] }
  };

  list.forEach(c => {
    const lastMsg = c.messages[c.messages.length - 1];
    const item = {
      phone: c.leadPhone,
      name: c.leadName || `Lead +${c.leadPhone}`,
      lastMessage: lastMsg?.text || (lastMsg?.mediaType ? '[Foto da Prova]' : 'Nova conversa'),
      time: lastMsg ? new Date(lastMsg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      state: c.state
    };

    if (c.state === 'NOVO') columns.novos.leads.push(item);
    else if (c.state === 'AGUARDANDO_NUMERO') columns.aguardando.leads.push(item);
    else if (c.state === 'ANALISANDO') columns.analise.leads.push(item);
    else if (c.state === 'PROPOSTA_ENVIADA' || c.state === 'NEGOCIACAO') columns.proposta.leads.push(item);
    else columns.pago.leads.push(item);
  });

  res.json(columns);
});

/**
 * Contatos
 */
router.get('/contacts', (req, res) => {
  const chats = db.getChats();
  const contacts = Object.values(chats).map(c => ({
    phone: c.leadPhone,
    name: c.leadName || `Lead +${c.leadPhone}`,
    state: c.state,
    totalMessages: c.messages.length,
    lastInteraction: c.lastMessageTime
  }));
  res.json(contacts);
});

/**
 * Estúdio: Gerador de Preview da Imagem Dinâmica
 */
router.post('/studio/preview', async (req, res) => {
  try {
    const { avatarUrl, coords } = req.body;
    const imgBuffer = await composeProofImage(avatarUrl, coords);
    res.set('Content-Type', 'image/png');
    res.send(imgBuffer);
  } catch (err) {
    console.error('[Studio Preview Error]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Integração Externa Síncrona (Leona / Webhook HTTP Request):
 * Recebe o número alvo, busca a foto, gera a imagem e retorna { url: "https://..." }
 */
router.all(['/generate-proof', '/gerar-foto'], async (req, res) => {
  try {
    const phone = req.body?.numero || req.query?.numero ||
                  req.body?.phone || req.query?.phone ||
                  req.body?.alvo || req.query?.alvo ||
                  req.body?.telefone || req.query?.telefone ||
                  req.body?.targetPhone || req.query?.targetPhone;

    if (!phone) {
      return res.status(400).json({ 
        success: false, 
        error: 'Parâmetro obrigatório ausente. Envie {"numero": "11999998888"} ou {"phone": "11999998888"}' 
      });
    }

    const rawDigits = String(phone).replace(/\D/g, '');
    const targetPhone = rawDigits.length <= 11 ? '55' + rawDigits : rawDigits;

    // 1. Busca foto de perfil do número alvo
    const photoUrl = await lookupProfilePicture(targetPhone);

    // 2. Compõe a imagem com as coordenadas configuradas
    const funnel = db.getFunnel();
    const imgBuffer = await composeProofImage(photoUrl, funnel?.avatarCoordinates);

    // 3. Salva no diretório público
    const proofsDir = path.join(__dirname, '../../public/generated');
    fs.mkdirSync(proofsDir, { recursive: true });
    const filename = `proof_${targetPhone}_${Date.now()}.png`;
    fs.writeFileSync(path.join(proofsDir, filename), imgBuffer);

    // 4. Monta a URL pública absoluta automaticamente
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const fullUrl = `${protocol}://${host}/generated/${filename}`;

    res.json({
      success: true,
      url: fullUrl,
      foto_url: fullUrl,
      phone: targetPhone,
      hasPhoto: Boolean(photoUrl)
    });
  } catch (err) {
    console.error('[Generate Proof API Error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Simulador de Lead (Teste completo dentro do Dashboard)
 */
router.post('/simulator/send', async (req, res) => {
  const { instanceId, phone } = req.body;
  const messageText = req.body.message || req.body.text;
  if (!phone || !messageText) return res.status(400).json({ error: 'Telefone e mensagem são obrigatórios' });

  // Dispara a mesma lógica do webhook
  await processIncomingMessage(instanceId || 'inst_1', phone, messageText);
  res.json({ success: true, message: 'Mensagem processada no funil' });
});

/**
 * Server-Sent Events (SSE) para atualização em tempo real do Live Chat
 */
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const onNewMessage = (data) => {
    res.write(`data: ${JSON.stringify({ type: 'new_message', data })}\n\n`);
  };

  const onChatUpdated = (data) => {
    res.write(`data: ${JSON.stringify({ type: 'chat_updated', data })}\n\n`);
  };

  const onInstancesUpdated = (data) => {
    res.write(`data: ${JSON.stringify({ type: 'instances_updated', data })}\n\n`);
  };

  const onConnectionStatus = (data) => {
    res.write(`data: ${JSON.stringify({ type: 'connection_status', data })}\n\n`);
  };

  const onChatTyping = (data) => {
    res.write(`data: ${JSON.stringify({ type: 'chat_typing', data })}\n\n`);
  };

  eventBus.on('new_message', onNewMessage);
  eventBus.on('chat_updated', onChatUpdated);
  eventBus.on('instances_updated', onInstancesUpdated);
  eventBus.on('connection_status', onConnectionStatus);
  eventBus.on('chat_typing', onChatTyping);

  // Keep-alive a cada 25 segundos para evitar timeout de proxies (Railway)
  const pingInterval = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(pingInterval);
    eventBus.removeListener('new_message', onNewMessage);
    eventBus.removeListener('chat_updated', onChatUpdated);
    eventBus.removeListener('instances_updated', onInstancesUpdated);
    eventBus.removeListener('connection_status', onConnectionStatus);
    eventBus.removeListener('chat_typing', onChatTyping);
  });
});

/**
 * =========================================================================
 * INTEGRAÇÃO OFICIAL FACEBOOK / META ADS & WHATSAPP
 * =========================================================================
 */
router.get('/facebook/status', (req, res) => {
  const settings = db.getSettings();
  const fb = settings.facebook || {
    connected: false,
    appId: '',
    userName: '',
    adAccounts: [],
    pixels: [],
    whatsappNumbers: []
  };
  res.json(fb);
});

/**
 * WhatsApp Embedded Signup (Cadastro Incorporado oficial da Meta)
 * Recebe o código temporário ou token retornado pelo popup da Meta e os dados do WABA e Phone Number
 */
router.post('/whatsapp/embedded-signup', async (req, res) => {
  try {
    const { code, accessToken, wabaId, phoneNumberId, name, coexistence, redirectUri, assignedFlowId } = req.body;
    let finalToken = accessToken;

    if (code) {
      console.log('[Embedded Signup] Trocando código da Meta por access_token...');
      const tokenRes = await metaService.exchangeCodeForToken(code, redirectUri);
      finalToken = tokenRes.access_token;
    }

    if (!finalToken) {
      return res.status(400).json({ error: 'Nenhum token ou código retornado pela Meta.' });
    }

    let phoneInfo = null;
    let targetPhoneId = phoneNumberId;
    let targetWabaId = wabaId;

    if (targetPhoneId) {
      try {
        phoneInfo = await metaService.getPhoneNumberDetails(targetPhoneId, finalToken);
      } catch (e) {
        console.warn('[Embedded Signup] Não foi possível obter detalhes diretos do phoneId:', e.message);
      }
    }

    // Se não veio phoneId nos dados de mensagem, busca nas WABAs acessíveis pelo token
    if (!phoneInfo || !targetPhoneId) {
      const metaDetails = await metaService.validateAndFetchMetaDetails(finalToken);
      if (metaDetails.whatsappNumbers && metaDetails.whatsappNumbers.length > 0) {
        const first = metaDetails.whatsappNumbers[0];
        targetPhoneId = first.phoneNumberId;
        targetWabaId = first.wabaId;
        phoneInfo = {
          display_phone_number: first.displayPhoneNumber,
          verified_name: first.verifiedName
        };
      }
    }

    // Inscreve o webhook do app no WABA para que as mensagens cheguem
    if (targetWabaId) {
      await metaService.subscribeAppToWaba(targetWabaId, finalToken);
    }

    // Registra na Cloud API caso necessário
    if (targetPhoneId) {
      await metaService.registerPhoneNumberOnCloudApi(targetPhoneId, finalToken);
    }

    const instances = db.getInstances();
    const newInstance = {
      id: `inst_meta_${Date.now()}`,
      name: name || phoneInfo?.verified_name || `WhatsApp Oficial ${phoneInfo?.display_phone_number || ''}`,
      phoneNumber: phoneInfo?.display_phone_number || 'WhatsApp Oficial Conectado',
      phoneNumberId: targetPhoneId || '',
      wabaId: targetWabaId || '',
      accessToken: finalToken,
      assignedFlowId: assignedFlowId || 'fluxo-espiao-foto',
      type: 'official',
      coexistence: Boolean(coexistence),
      status: 'connected',
      totalSent: 0,
      totalReceived: 0,
      createdAt: new Date().toISOString()
    };

    // Atualiza se já existir ou adiciona
    const existingIdx = instances.findIndex(i => i.phoneNumberId && i.phoneNumberId === targetPhoneId);
    if (existingIdx >= 0) {
      instances[existingIdx] = {
        ...instances[existingIdx],
        ...newInstance,
        assignedFlowId: assignedFlowId || instances[existingIdx].assignedFlowId || 'fluxo-espiao-foto'
      };
    } else {
      instances.push(newInstance);
    }
    db.saveInstances(instances);

    // Salva token e dados do usuário nas configurações globais da Meta
    const settings = db.getSettings();
    if (!settings.facebook) settings.facebook = {};
    settings.facebook.connected = true;
    settings.facebook.accessToken = finalToken;

    try {
      const metaDetails = await metaService.validateAndFetchMetaDetails(finalToken);
      if (metaDetails.user) {
        settings.facebook.userId = metaDetails.user.id;
        settings.facebook.userName = metaDetails.user.name;
        settings.facebook.userEmail = metaDetails.user.email;
      }
      if (metaDetails.adAccounts && metaDetails.adAccounts.length > 0) {
        settings.facebook.adAccounts = metaDetails.adAccounts;
        if (!settings.facebook.adAccountId) {
          settings.facebook.adAccountId = metaDetails.adAccounts[0].id;
          settings.facebook.adAccountName = metaDetails.adAccounts[0].name;
        }
      }
      if (metaDetails.pixels && metaDetails.pixels.length > 0) {
        settings.facebook.pixels = metaDetails.pixels;
        if (!settings.facebook.pixelId) {
          settings.facebook.pixelId = metaDetails.pixels[0].id;
          settings.facebook.pixelName = metaDetails.pixels[0].name;
        }
      }
    } catch(e) {
      console.warn('[Embedded Signup] Aviso buscando detalhes da conta:', e.message);
    }

    db.saveSettings(settings);

    console.log('[Embedded Signup] Sucesso! Instância registrada:', newInstance.name);
    res.json({ success: true, instance: newInstance });
  } catch (err) {
    console.error('[Embedded Signup Error]', err);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

router.post('/facebook/connect', async (req, res) => {
  try {
    let { accessToken, code, appId, appSecret, redirectUri } = req.body;
    if (!accessToken && code) {
      const tokenRes = await metaService.exchangeCodeForToken(code, redirectUri);
      accessToken = tokenRes.access_token;
    }
    if (!accessToken) {
      return res.status(400).json({ error: 'Token de acesso da Meta é obrigatório' });
    }

    console.log('[Meta API] Validando e buscando contas da Meta...');
    const metaData = await metaService.validateAndFetchMetaDetails(accessToken);

    const settings = db.getSettings();
    if (!settings.facebook) settings.facebook = {};

    settings.facebook = {
      connected: true,
      appId: appId || settings.facebook.appId || '',
      appSecret: appSecret || settings.facebook.appSecret || '',
      accessToken: accessToken,
      userId: metaData.user.id,
      userName: metaData.user.name,
      userEmail: metaData.user.email,
      adAccounts: metaData.adAccounts,
      pixels: metaData.pixels,
      whatsappNumbers: metaData.whatsappNumbers,
      connectedAt: new Date().toISOString()
    };

    // Se encontrou contas de anúncio, seleciona a primeira por padrão
    if (metaData.adAccounts.length > 0 && !settings.facebook.adAccountId) {
      settings.facebook.adAccountId = metaData.adAccounts[0].id;
      settings.facebook.adAccountName = metaData.adAccounts[0].name;
    }

    // Se encontrou pixels, seleciona o primeiro por padrão
    if (metaData.pixels.length > 0 && !settings.facebook.pixelId) {
      settings.facebook.pixelId = metaData.pixels[0].id;
      settings.facebook.pixelName = metaData.pixels[0].name;
    }

    // Se encontrou números de WhatsApp da Meta, cadastra automaticamente nas instâncias
    if (metaData.whatsappNumbers.length > 0) {
      const instances = db.getInstances();
      metaData.whatsappNumbers.forEach((num, idx) => {
        const existing = instances.find(i => i.phoneNumberId === num.phoneNumberId);
        if (!existing) {
          instances.push({
            id: `inst_meta_${Date.now()}_${idx}`,
            name: num.verifiedName || `WhatsApp Meta ${num.displayPhoneNumber}`,
            phoneNumber: num.displayPhoneNumber,
            phoneNumberId: num.phoneNumberId,
            wabaId: num.wabaId,
            accessToken: accessToken,
            status: 'connected',
            totalSent: 0,
            totalReceived: 0,
            createdAt: new Date().toISOString()
          });
        }
      });
      db.saveInstances(instances);
    }

    db.saveSettings(settings);
    res.json({ success: true, facebook: settings.facebook });
  } catch (err) {
    console.error('[Meta Connect Error]', err);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

router.post('/facebook/select-pixel', (req, res) => {
  const { pixelId, adAccountId } = req.body;
  const settings = db.getSettings();
  if (!settings.facebook) settings.facebook = {};

  if (pixelId) {
    settings.facebook.pixelId = pixelId;
    const found = (settings.facebook.pixels || []).find(p => p.id === pixelId);
    if (found) settings.facebook.pixelName = found.name;
  }

  if (adAccountId) {
    settings.facebook.adAccountId = adAccountId;
    const found = (settings.facebook.adAccounts || []).find(a => a.id === adAccountId);
    if (found) settings.facebook.adAccountName = found.name;
  }

  db.saveSettings(settings);
  res.json({ success: true, facebook: settings.facebook });
});

router.post('/facebook/disconnect', (req, res) => {
  const settings = db.getSettings();
  settings.facebook = {
    connected: false,
    appId: settings.facebook?.appId || '',
    appSecret: '',
    accessToken: '',
    userName: '',
    adAccounts: [],
    pixels: [],
    whatsappNumbers: []
  };
  db.saveSettings(settings);
  res.json({ success: true });
});

/* =========================================================================
   ROTAS DE PIXELS DO FACEBOOK (CAPI / EVENTOS SERVER-SIDE)
   ========================================================================= */

router.get('/pixels', (req, res) => {
  const pixels = db.getPixels();
  res.json(pixels);
});

router.post('/pixels', (req, res) => {
  const { name, pixelId, accessToken, pageId, testEventCode } = req.body;
  if (!pixelId || !accessToken) {
    return res.status(400).json({ error: 'Pixel ID e Access Token são obrigatórios' });
  }

  const saved = db.addPixel({
    name: name || `Pixel ${pixelId}`,
    pixelId: String(pixelId).trim(),
    accessToken: String(accessToken).trim(),
    pageId: pageId ? String(pageId).trim() : '',
    testEventCode: testEventCode ? String(testEventCode).trim() : ''
  });

  res.json({ success: true, pixel: saved });
});

router.delete('/pixels/:id', (req, res) => {
  db.deletePixel(req.params.id);
  res.json({ success: true });
});

router.post('/pixels/test', async (req, res) => {
  const { pixelId, accessToken, eventName, phone, value, currency, pageId, testEventCode } = req.body;
  if (!pixelId || !accessToken) {
    return res.status(400).json({ error: 'Pixel ID e Access Token são obrigatórios' });
  }

  try {
    const result = await metaService.sendPixelConversion(
      pixelId,
      accessToken,
      eventName || 'Purchase',
      phone || '5511999999999',
      {
        value: Number(value) || 49.90,
        currency: currency || 'BRL',
        pageId: pageId || undefined,
        testEventCode: testEventCode || undefined
      }
    );

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/pixels/logs', (req, res) => {
  const logs = db.getPixelLogs();
  res.json(logs);
});

/* =========================================================================
   WEBHOOK UNIVERSAL DE PAGAMENTOS (KIRVANO, KIWIFY, PERFECTPAY, ETC.)
   ========================================================================= */

router.post('/webhooks/payment', async (req, res) => {
  try {
    const body = req.body || {};
    console.log('[Webhook Payment] Notificação recebida:', JSON.stringify(body));

    // Extrai telefone do cliente em diferentes formatos de gateway
    const rawPhone = 
      body.phone ||
      body.customer?.phone ||
      body.customer?.mobile ||
      body.buyer?.phone ||
      body.client?.phone ||
      body.data?.customer?.phone ||
      body.data?.phone || '';

    const cleanPhone = String(rawPhone).replace(/\D/g, '');

    // Extrai valor monetário
    const rawAmount = 
      body.amount ||
      body.price ||
      body.value ||
      body.total ||
      body.data?.amount ||
      body.data?.price || 49.90;

    const amount = typeof rawAmount === 'number' ? rawAmount : parseFloat(String(rawAmount).replace(',', '.')) || 49.90;

    // Extrai status e evento
    const status = (body.status || body.event || body.order_status || 'approved').toLowerCase();
    const isApproved = status.includes('approv') || status.includes('paid') || status.includes('pago') || status.includes('conclud');

    // Registra a venda no banco
    const sale = db.addSale({
      phone: cleanPhone || 'desconhecido',
      amount: amount,
      currency: body.currency || 'BRL',
      status: isApproved ? 'aprovado' : status,
      platform: body.platform || 'Kirvano / Gateway',
      orderId: body.order_id || body.id || `ord_${Date.now()}`,
      productName: body.product_name || body.product?.name || 'Acesso Painel Mavrol'
    });

    // Se tiver telefone válido, atualiza o lead no CRM
    if (cleanPhone) {
      const chats = db.getChats();
      let chat = chats[cleanPhone];
      if (chat) {
        chat.paidTotal = (chat.paidTotal || 0) + amount;
        chat.lastPaymentTime = new Date().toISOString();
        chat.orderStatus = isApproved ? 'PAGO' : status;
        db.saveChats(chats);
        eventBus.emit('chat_updated', { phone: cleanPhone });
      }
    }

    // Se estiver aprovado, confirma venda na atribuição de tráfego e dispara Pixels
    if (isApproved) {
      db.confirmAttributionSale(cleanPhone, amount);

      const pixels = db.getPixels();
      if (pixels && pixels.length > 0) {
        const primaryPixel = pixels[0];
        try {
          await metaService.sendPixelConversion(
            primaryPixel.pixelId,
            primaryPixel.accessToken,
            'Purchase',
            cleanPhone,
            {
              value: amount,
              currency: 'BRL',
              pageId: primaryPixel.pageId || undefined,
              testEventCode: primaryPixel.testEventCode || undefined
            }
          );
        } catch (pixErr) {
          console.warn('[Webhook Payment] Aviso disparando CAPI:', pixErr.message);
        }
      }

      // Disparo TikTok Events API v1.3
      const ttPixels = db.getTikTokPixels();
      if (ttPixels && ttPixels.length > 0) {
        const attribution = db.getTrafficAttributionByPhone(cleanPhone);
        tiktokService.sendTikTokEvent({
          pixelCode: ttPixels[0].pixel_code,
          accessToken: ttPixels[0].access_token,
          eventName: 'CompletePayment',
          phone: cleanPhone,
          attribution,
          value: amount,
          currency: 'BRL',
          eventId: `tt_sale_${cleanPhone}_${Date.now()}`
        }).catch(ttErr => {
          console.warn('[Webhook Payment] Aviso disparando TikTok Events API:', ttErr.message);
        });
      }
    }

    eventBus.emit('new_sale', sale);
    res.json({ success: true, message: 'Webhook processado com sucesso', saleId: sale.id });
  } catch (err) {
    console.error('[Webhook Payment Error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =========================================================================
   ESTATÍSTICAS DA DASHBOARD & FUNIL DE CONVERSÃO
   ========================================================================= */

router.get('/dashboard/stats', (req, res) => {
  const chats = db.getChats();
  const sales = db.getSales();
  const pixels = db.getPixels();
  const pixelLogs = db.getPixelLogs();

  const chatList = Object.values(chats);
  const totalLeads = chatList.length;

  // 1. Etapas do funil com contagens reais
  const stepStarted = totalLeads;
  const stepNumberProvided = chatList.filter(c => c.variables?.alvo || (c.messages || []).length > 2).length;
  const stepProofGenerated = chatList.filter(c => c.variables?.photoUrl || (c.messages || []).some(m => m.mediaType === 'image')).length;
  const stepOfferSent = chatList.filter(c => c.state === 'OFERTA_ENVIADA' || c.state === 'NEGOCIACAO' || c.state === 'FINALIZADO' || c.upsellStage !== 'stage_49').length;
  
  const stepPaid49 = chatList.filter(c => ['stage_100', 'stage_200', 'stage_400', 'stage_finalizado'].includes(c.upsellStage) || (c.paidTotal && c.paidTotal >= 49)).length;
  const stepPaid100 = chatList.filter(c => ['stage_200', 'stage_400', 'stage_finalizado'].includes(c.upsellStage) || (c.paidTotal && c.paidTotal >= 149)).length;
  const stepPaid200 = chatList.filter(c => ['stage_400', 'stage_finalizado'].includes(c.upsellStage) || (c.paidTotal && c.paidTotal >= 349)).length;
  const stepPaid400 = chatList.filter(c => c.upsellStage === 'stage_finalizado' || c.state === 'FINALIZADO' || (c.paidTotal && c.paidTotal >= 749)).length;

  // 2. Cálculos financeiros
  const approvedSales = sales.filter(s => s.status === 'aprovado');
  const totalRevenue = approvedSales.reduce((acc, s) => acc + Number(s.amount || 0), 0);
  const averageTicket = approvedSales.length > 0 ? (totalRevenue / approvedSales.length) : 0;
  const globalConversionRate = totalLeads > 0 ? ((stepPaid49 / totalLeads) * 100).toFixed(1) : '0.0';

  // 3. Taxas de retenção de cada etapa (%)
  const calcRate = (current, total) => total > 0 ? ((current / total) * 100).toFixed(1) : '0.0';

  const funnelStages = [
    { name: '1. Início (Boas-Vindas)', count: stepStarted, pct: '100%', drop: '0%', color: '#3b82f6' },
    { name: '2. Número Enviado', count: stepNumberProvided, pct: `${calcRate(stepNumberProvided, stepStarted)}%`, color: '#6366f1' },
    { name: '3. Prova Gerada', count: stepProofGenerated, pct: `${calcRate(stepProofGenerated, stepStarted)}%`, color: '#8b5cf6' },
    { name: '4. Oferta R$ 49,90', count: stepOfferSent, pct: `${calcRate(stepOfferSent, stepStarted)}%`, color: '#ec4899' },
    { name: '5. Pagou R$ 49,90', count: stepPaid49, pct: `${calcRate(stepPaid49, stepStarted)}%`, color: '#10b981' },
    { name: '6. Upsell R$ 100', count: stepPaid100, pct: `${calcRate(stepPaid100, stepStarted)}%`, color: '#059669' },
    { name: '7. Upsell R$ 200', count: stepPaid200, pct: `${calcRate(stepPaid200, stepStarted)}%`, color: '#047857' },
    { name: '8. Acesso Master R$ 400', count: stepPaid400, pct: `${calcRate(stepPaid400, stepStarted)}%`, color: '#065f46' }
  ];

  // 4. Vendas agrupadas para gráfico
  const salesByDay = {};
  sales.forEach(s => {
    const day = s.timestamp ? s.timestamp.substring(0, 10) : 'Hoje';
    salesByDay[day] = (salesByDay[day] || 0) + Number(s.amount || 0);
  });

  res.json({
    kpis: {
      totalRevenue: totalRevenue.toFixed(2),
      salesCount: approvedSales.length,
      averageTicket: averageTicket.toFixed(2),
      totalLeads,
      globalConversionRate: `${globalConversionRate}%`,
      activePixelsCount: pixels.length,
      pixelEventsCount: pixelLogs.length
    },
    funnel: funnelStages,
    salesChart: salesByDay,
    recentSales: sales.slice(0, 8),
    recentPixelLogs: pixelLogs.slice(0, 6)
  });
});

/**
 * =========================================================================
 * TESTE DE REQUISIÇÃO DE INTEGRAÇÃO (NÓ DO FLUXO)
 * =========================================================================
 */
router.post('/integrations/test', async (req, res) => {
  try {
    const { method = 'GET', url, headers = {}, body } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL da requisição é obrigatória' });
    }

    // Interpolação de variáveis de teste para a simulação
    const dummyVars = {
      '{phone_number}': '5511999999999',
      '{telefone}': '5511999999999',
      '{nome}': 'Carlos Eduardo',
      '{full_name}': 'Carlos Eduardo',
      '{primeiro_nome}': 'Carlos',
      '{email}': 'carlos@exemplo.com',
      '{comprovante.valor}': '4990',
      '{valor_atual}': '49.90',
      '{token}': 'demo_token_123'
    };

    let resolvedUrl = url;
    for (const [key, val] of Object.entries(dummyVars)) {
      resolvedUrl = resolvedUrl.split(key).join(val);
    }

    let parsedHeaders = typeof headers === 'string' ? {} : (headers || {});
    if (typeof headers === 'string' && headers.trim()) {
      try {
        let hText = headers;
        for (const [key, val] of Object.entries(dummyVars)) {
          hText = hText.split(key).join(val);
        }
        parsedHeaders = JSON.parse(hText);
      } catch (e) {
        // Fallback se não for JSON válido
        parsedHeaders = { 'Content-Type': 'application/json' };
      }
    }

    let fetchOptions = {
      method: method.toUpperCase(),
      headers: parsedHeaders,
      signal: AbortSignal.timeout(10000)
    };

    if (['POST', 'PUT', 'PATCH'].includes(fetchOptions.method) && body) {
      let bText = typeof body === 'string' ? body : JSON.stringify(body);
      for (const [key, val] of Object.entries(dummyVars)) {
        bText = bText.split(key).join(val);
      }
      fetchOptions.body = bText;
    }

    const response = await fetch(resolvedUrl, fetchOptions);
    const contentType = response.headers.get('content-type') || '';
    let responseData;
    if (contentType.includes('application/json')) {
      responseData = await response.json();
    } else {
      responseData = await response.text();
    }

    res.json({
      success: true,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      data: responseData
    });
  } catch (err) {
    res.json({
      success: false,
      status: 500,
      statusText: 'Request Failed',
      ok: false,
      error: err.message,
      data: { error: err.message, code: 'FETCH_ERROR' }
    });
  }
});

/**
 * =========================================================================
 * ATRIBUIÇÃO DE TRÁFEGO PAGO (TIKTOK ADS) & LINKS DE CAMPANHA
 * =========================================================================
 */

// Listar campanhas de tráfego
router.get('/traffic/campaigns', (req, res) => {
  const campaigns = db.getTrafficCampaigns();
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'http';

  const mapped = campaigns.map(c => {
    const domainToUse = c.custom_domain || host;
    const protoToUse = c.custom_domain ? 'https' : protocol;
    return {
      ...c,
      shortUrl: `${protoToUse}://${domainToUse}/c/${c.slug}`,
      targetPresellWithCodeSample: `${c.presell_url}${c.presell_url.includes('?') ? '&' : '?'}codigo=AB79KP`,
      whatsappSample: `https://wa.me/${(c.whatsapp_number || '').replace(/\D/g, '')}?text=${encodeURIComponent((c.message_template || '').replace('{codigo}', 'AB79KP'))}`
    };
  });

  res.json(mapped);
});

// Criar nova campanha
router.post('/traffic/campaigns', (req, res) => {
  const { name, presell_url, whatsapp_number, message_template, slug, custom_domain } = req.body;

  if (!name || !presell_url || !whatsapp_number) {
    return res.status(400).json({ error: 'Nome, URL de destino (pressel) e WhatsApp são obrigatórios' });
  }

  const campaign = db.addTrafficCampaign({
    name,
    presell_url,
    whatsapp_number,
    message_template,
    slug,
    custom_domain: custom_domain ? String(custom_domain).trim().toLowerCase() : null
  });

  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'http';
  const domainToUse = campaign.custom_domain || host;
  const protoToUse = campaign.custom_domain ? 'https' : protocol;

  res.json({
    success: true,
    campaign: {
      ...campaign,
      shortUrl: `${protoToUse}://${domainToUse}/c/${campaign.slug}`
    }
  });
});

// Excluir campanha
router.delete('/traffic/campaigns/:id', (req, res) => {
  const ok = db.deleteTrafficCampaign(req.params.id);
  res.json({ success: ok });
});

// Listar atribuições de tráfego (acessos brutos)
router.get('/traffic/attributions', (req, res) => {
  res.json(db.getTrafficAttributions());
});

// Relatório consolidado de tráfego agrupado por UTM Campaign / UTM Content
router.get('/traffic/report', (req, res) => {
  const attributions = db.getTrafficAttributions();
  const totalClicks = attributions.length;
  const totalLeads = attributions.filter(a => a.telefone_vinculado).length;
  const totalSales = attributions.filter(a => a.venda_confirmada).length;
  const totalRevenue = attributions.filter(a => a.venda_confirmada).reduce((acc, a) => acc + (parseFloat(a.venda_valor) || 0), 0);

  const globalLeadRate = totalClicks > 0 ? ((totalLeads / totalClicks) * 100).toFixed(1) : '0.0';
  const globalSaleRate = totalLeads > 0 ? ((totalSales / totalLeads) * 100).toFixed(1) : '0.0';
  const clickToSaleRate = totalClicks > 0 ? ((totalSales / totalClicks) * 100).toFixed(1) : '0.0';

  // Agrupamento por UTM Campaign + UTM Content
  const groups = {};
  attributions.forEach(attr => {
    const campKey = attr.campanha_nome || attr.utm_campaign || 'Orgânico / Direto';
    const contentKey = attr.utm_content || '-';
    const sourceKey = attr.utm_source || 'tiktok';
    const groupKey = `${campKey}___${contentKey}___${sourceKey}`;

    if (!groups[groupKey]) {
      groups[groupKey] = {
        campaign: campKey,
        content: contentKey,
        source: sourceKey,
        utm_medium: attr.utm_medium || '-',
        clicks: 0,
        leads: 0,
        sales: 0,
        revenue: 0,
        recentAt: attr.criado_em
      };
    }

    groups[groupKey].clicks += 1;
    if (attr.telefone_vinculado) groups[groupKey].leads += 1;
    if (attr.venda_confirmada) {
      groups[groupKey].sales += 1;
      groups[groupKey].revenue += (parseFloat(attr.venda_valor) || 0);
    }
  });

  const groupedRows = Object.values(groups).map(g => ({
    ...g,
    revenueFormatted: `R$ ${g.revenue.toFixed(2)}`,
    leadRate: g.clicks > 0 ? `${((g.leads / g.clicks) * 100).toFixed(1)}%` : '0.0%',
    conversionRate: g.leads > 0 ? `${((g.sales / g.leads) * 100).toFixed(1)}%` : '0.0%',
    clickToSaleRate: g.clicks > 0 ? `${((g.sales / g.clicks) * 100).toFixed(1)}%` : '0.0%'
  })).sort((a, b) => b.sales - a.sales || b.clicks - a.clicks);

  res.json({
    kpis: {
      totalClicks,
      totalLeads,
      totalSales,
      totalRevenue: totalRevenue.toFixed(2),
      globalLeadRate: `${globalLeadRate}%`,
      globalSaleRate: `${globalSaleRate}%`,
      clickToSaleRate: `${clickToSaleRate}%`
    },
    campaignGroups: groupedRows,
    recentAttributions: attributions.slice(0, 50)
  });
});

/**
 * =========================================================================
 * ENDPOINT DO FLUXO AO VIVO (MONITORAMENTO EM TEMPO REAL)
 * =========================================================================
 */
router.get('/traffic/live-flow', (req, res) => {
  try {
    const chats = db.getChats() || {};
    const attributions = db.getTrafficAttributions() || [];
    const chatList = Object.values(chats);

    // 1. Mapeamento de Leads Ativos por Node
    const nodeCounts = {
      'node-start': 0,
      'node-welcome': 0,
      'node-wait-reply': 0,
      'node-condition-phone': 0,
      'node-doubt-welcome': 0,
      'node-reinf-phone': 0,
      'node-analyzing-msg': 0,
      'node-delay': 0,
      'node-api-lookup': 0,
      'node-photo-branch': 0,
      'node-proof-template-1': 0,
      'node-proof-template-2': 0,
      'node-offer-pix-49': 0,
      'node-msg-comprovante': 0,
      'node-wait-reaction': 0,
      'node-ai-sentiment': 0,
      'node-upsell-100': 0,
      'node-wait-upsell-100': 0,
      'node-ai-objection-100': 0,
      'node-upsell-200': 0,
      'node-wait-upsell-200': 0,
      'node-ai-objection-200': 0,
      'node-upsell-400': 0,
      'node-wait-upsell-400': 0,
      'node-ai-objection-400': 0,
      'node-access-released': 0
    };

    chatList.forEach(c => {
      const state = c.state || 'NOVO';
      const stage = c.upsellStage || 'stage_49';

      if (state === 'NOVO') nodeCounts['node-welcome']++;
      else if (state === 'AGUARDANDO_NUMERO') nodeCounts['node-wait-reply']++;
      else if (state === 'ANALISANDO') nodeCounts['node-delay']++;
      else if (state === 'OFERTA_ENVIADA' || state === 'NEGOCIACAO') {
        if (stage === 'stage_49') nodeCounts['node-offer-pix-49']++;
        else if (stage === 'stage_100') nodeCounts['node-upsell-100']++;
        else if (stage === 'stage_200') nodeCounts['node-upsell-200']++;
        else if (stage === 'stage_400') nodeCounts['node-upsell-400']++;
      } else if (state === 'FINALIZADO') {
        nodeCounts['node-access-released']++;
      }
    });

    // 2. Taxas Horárias e Totais por Plataforma de Origem
    const oneHourAgo = Date.now() - 3600 * 1000;
    let ttRecent = 0;
    let fbRecent = 0;
    let organicRecent = 0;

    let ttTotal = 0;
    let fbTotal = 0;
    let organicTotal = 0;

    attributions.forEach(attr => {
      const created = new Date(attr.criado_em).getTime();
      const isLastHour = created >= oneHourAgo;
      const plat = (attr.platform || (attr.ttclid ? 'tiktok' : (attr.fbclid ? 'facebook' : 'organico'))).toLowerCase();

      if (plat === 'tiktok') {
        ttTotal++;
        if (isLastHour) ttRecent++;
      } else if (plat === 'facebook') {
        fbTotal++;
        if (isLastHour) fbRecent++;
      } else {
        organicTotal++;
        if (isLastHour) organicRecent++;
      }
    });

    // 3. Monta lista de eventos recentes para o Terminal de Feed ao Vivo
    const events = [];
    attributions.slice(0, 30).forEach(attr => {
      const plat = (attr.platform || (attr.ttclid ? 'tiktok' : (attr.fbclid ? 'facebook' : 'organico'))).toLowerCase();
      const phoneMasked = attr.telefone_vinculado 
        ? `+${attr.telefone_vinculado.slice(0, 4)}...${attr.telefone_vinculado.slice(-4)}`
        : `Clique [${attr.codigo}]`;

      let action = 'Entrou no Link de Campanha';
      if (attr.venda_confirmada) action = `💰 Comprou R$ ${(parseFloat(attr.venda_valor) || 49.90).toFixed(2)}`;
      else if (attr.telefone_vinculado) action = 'Entrou no WhatsApp (Boas-Vindas)';

      events.push({
        id: `ev_${attr.codigo}_${attr.criado_em}`,
        time: new Date(attr.confirmado_em || attr.vinculado_em || attr.criado_em).toLocaleTimeString('pt-BR'),
        platform: plat,
        title: action,
        phone: phoneMasked,
        campaign: attr.campanha_nome || 'Campanha Direta'
      });
    });

    // 4. Intensidade de Partículas nas Conexões (Cargas de Tráfego)
    const edgeFlows = {
      'e1': Math.max(1, Math.min(5, Math.ceil((nodeCounts['node-welcome'] || 1)))),
      'e2': Math.max(1, Math.min(4, Math.ceil((nodeCounts['node-wait-reply'] || 1)))),
      'e3': 2,
      'e8': Math.max(1, Math.min(4, Math.ceil((nodeCounts['node-delay'] || 1)))),
      'e10': 2,
      'e11': 2,
      'e14': 2,
      'e16': Math.max(1, Math.min(5, Math.ceil((nodeCounts['node-offer-pix-49'] || 1)))),
      'e19': Math.max(1, Math.min(4, Math.ceil((nodeCounts['node-upsell-100'] || 1)))),
      'e22': Math.max(1, Math.min(3, Math.ceil((nodeCounts['node-upsell-200'] || 1)))),
      'e25': Math.max(1, Math.min(3, Math.ceil((nodeCounts['node-upsell-400'] || 1))))
    };

    res.json({
      success: true,
      activeNodes: nodeCounts,
      totalActiveLeads: chatList.length,
      platformRates: {
        tiktok: { lastHour: ttRecent, total: ttTotal },
        facebook: { lastHour: fbRecent, total: fbTotal },
        organic: { lastHour: organicRecent, total: organicTotal }
      },
      edgeFlows,
      recentEvents: events
    });
  } catch (err) {
    console.error('[Live Flow API Error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * =========================================================================
 * PIXELS TIKTOK (EVENTS API v1.3)
 * =========================================================================
 */

// Listar pixels cadastrados
router.get('/tiktok/pixels', (req, res) => {
  res.json(db.getTikTokPixels());
});

// Cadastrar/atualizar pixel
router.post('/tiktok/pixels', (req, res) => {
  const { name, pixel_code, access_token } = req.body;
  if (!pixel_code || !access_token) {
    return res.status(400).json({ error: 'pixel_code e access_token são obrigatórios' });
  }

  const saved = db.addTikTokPixel({
    name: name || 'Pixel TikTok',
    pixel_code,
    access_token
  });

  res.json({ success: true, pixel: saved });
});

// Excluir pixel
router.delete('/tiktok/pixels/:id', (req, res) => {
  const ok = db.deleteTikTokPixel(req.params.id);
  res.json({ success: ok });
});

// Logs de disparo do TikTok
router.get('/tiktok/logs', (req, res) => {
  res.json(db.getTikTokLogs());
});

// Disparo de teste para o TikTok Pixel
router.post('/tiktok/test', async (req, res) => {
  try {
    const { pixel_code, access_token, event_name, phone, value } = req.body;
    let code = pixel_code;
    let token = access_token;

    if (!code || !token) {
      const pixels = db.getTikTokPixels();
      if (pixels.length > 0) {
        code = code || pixels[0].pixel_code;
        token = token || pixels[0].access_token;
      }
    }

    if (!code || !token) {
      return res.status(400).json({ success: false, error: 'Cadastre um Pixel TikTok com pixel_code e access_token antes de testar.' });
    }

    const testPhone = phone || '5511999998888';
    const testEvent = event_name || 'CompletePayment';
    const testValue = parseFloat(value) || 49.90;

    const result = await tiktokService.sendTikTokEvent({
      pixelCode: code,
      accessToken: token,
      eventName: testEvent,
      phone: testPhone,
      attribution: {
        ttclid: 'TEST_TTCLID_MANUAL_' + Date.now(),
        ttp: 'TEST_TTP_COOKIE_DEMO',
        pressel_url: 'https://minhapressel.com'
      },
      value: testValue,
      currency: 'BRL',
      eventId: `tt_test_manual_${Date.now()}`
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * =========================================================================
 * SIMULADOR DE CADEIA COMPLETA DE ATRIBUIÇÃO (TEST CHAIN)
 * =========================================================================
 * Requisito 7: Endpoint de teste que simula uma passagem completa:
 * 1. Gera clique de anúncio TikTok com ttclid, utm_campaign, utm_content, _ttp e código único
 * 2. Simula o lead enviando a mensagem no WhatsApp com o código
 * 3. Valida se telefone_vinculado foi preenchido
 * 4. Simula confirmação de venda e disparo da TikTok Events API
 * 5. Retorna o diagnóstico detalhado de toda a cadeia
 */
router.post('/tiktok/test-chain', async (req, res) => {
  try {
    const testPhone = req.body.phone ? String(req.body.phone).replace(/\D/g, '') : `55119${Math.floor(10000000 + Math.random() * 90000000)}`;
    const testCampaign = req.body.utm_campaign || 'tiktok_ads_espiao_vsl';
    const testContent = req.body.utm_content || 'criativo_audio_zap_v1';
    const testAmount = parseFloat(req.body.amount) || 49.90;

    const diagnostics = {
      step1_click: { status: 'pending' },
      step2_inbound_message: { status: 'pending' },
      step3_phone_binding: { status: 'pending' },
      step4_sale_and_capi: { status: 'pending' },
      summary: {}
    };

    // ETAPA 1: Simular clique no link /c/ e gravação de atribuição
    const code = db.generateUniqueAttributionCode();
    const ttclid = 'ttclid_test_' + Date.now();
    const ttp = 'ttp_cookie_test_' + Math.random().toString(36).substring(2, 10);

    const attribution = db.addTrafficAttribution({
      codigo: code,
      ttclid,
      ttp,
      utm_source: 'tiktok',
      utm_medium: 'paid_cpc',
      utm_campaign: testCampaign,
      utm_content: testContent,
      utm_term: 'espiao_whatsapp',
      campanha_nome: 'Campanha Teste TikTok Ads',
      pressel_url: 'https://minhapressel.com/oferta'
    });

    diagnostics.step1_click = {
      status: 'success',
      code: code,
      ttclid: ttclid,
      ttp: ttp,
      redirect_url: `https://minhapressel.com/oferta?codigo=${code}`,
      attributionId: attribution.id
    };

    // ETAPA 2: Simular lead chegando no WhatsApp com o template de mensagem
    const incomingText = `Oii vim pelo TikTok (código ${code})`;
    // Executa a vinculação via processIncomingMessage
    await processIncomingMessage('inst_1', testPhone, incomingText);

    diagnostics.step2_inbound_message = {
      status: 'success',
      leadPhone: testPhone,
      messageSent: incomingText
    };

    // ETAPA 3: Verificar vinculação no banco
    const updatedAttr = db.getTrafficAttributionByCode(code);
    const isBound = updatedAttr && updatedAttr.telefone_vinculado === testPhone;

    diagnostics.step3_phone_binding = {
      status: isBound ? 'success' : 'failed',
      verifiedPhone: updatedAttr?.telefone_vinculado || null,
      vinculado_em: updatedAttr?.vinculado_em || null,
      message: isBound ? 'Telefone E.164 vinculado com sucesso à atribuição!' : 'Falha ao vincular telefone ao código.'
    };

    // ETAPA 4: Simular venda confirmada e disparo TikTok Events API
    let tiktokDispatchResult = null;
    const ttPixels = db.getTikTokPixels();
    if (ttPixels && ttPixels.length > 0) {
      tiktokDispatchResult = await tiktokService.sendTikTokEvent({
        pixelCode: ttPixels[0].pixel_code,
        accessToken: ttPixels[0].access_token,
        eventName: 'CompletePayment',
        phone: testPhone,
        attribution: updatedAttr,
        value: testAmount,
        currency: 'BRL',
        eventId: `sim_chain_${Date.now()}`
      });
    } else {
      tiktokDispatchResult = {
        success: true,
        skipped: true,
        message: 'Nenhum pixel TikTok cadastrado no painel. Venda confirmada no banco com sucesso.'
      };
    }

    // Confirma a venda na atribuição
    db.confirmAttributionSale(testPhone, testAmount);

    const finalAttr = db.getTrafficAttributionByCode(code);

    diagnostics.step4_sale_and_capi = {
      status: finalAttr?.venda_confirmada ? 'success' : 'failed',
      venda_confirmada: finalAttr?.venda_confirmada || false,
      venda_valor: finalAttr?.venda_valor || testAmount,
      confirmado_em: finalAttr?.confirmado_em || null,
      tiktok_api: tiktokDispatchResult
    };

    diagnostics.summary = {
      allStepsPassed: diagnostics.step1_click.status === 'success' &&
                       diagnostics.step2_inbound_message.status === 'success' &&
                       diagnostics.step3_phone_binding.status === 'success' &&
                       diagnostics.step4_sale_and_capi.status === 'success',
      code: code,
      phone: testPhone,
      campaign: testCampaign,
      content: testContent,
      saleConfirmed: finalAttr?.venda_confirmada || false
    };

    res.json({
      success: diagnostics.summary.allStepsPassed,
      diagnostics
    });
  } catch (err) {
    console.error('[Test Chain Error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.autoRestoreUazapiInstances = autoRestoreUazapiInstances;
router.syncUazapiInstanceData = syncUazapiInstanceData;
module.exports = router;
