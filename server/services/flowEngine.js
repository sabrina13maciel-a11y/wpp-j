const db = require('../storage/db');
const { composeProofImage } = require('./imageComposer');
const metaService = require('./metaService');
const tiktokService = require('./tiktokService');
const aiService = require('./aiService');
const uazapiService = require('./uazapiService');
const cryptoService = require('./cryptoService');
const EventEmitter = require('events');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const eventBus = new EventEmitter();

/**
 * Simula status de presença 'composing' (digitando) nativo no WhatsApp e no Live Chat
 */
async function simulateTyping(inst, cleanPhone, durationMs = 2000, presenceType = 'composing') {
  if (!cleanPhone) return;

  // Notifica o Live Chat do painel que o bot está digitando
  eventBus.emit('chat_typing', { phone: cleanPhone, isTyping: true, who: 'bot' });

  // Envia presença nativa na uazapi para o WhatsApp do contato
  if (inst && inst.tipo === 'uazapi' && inst.instance_token) {
    try {
      const decToken = cryptoService.decrypt(inst.instance_token);
      await uazapiService.sendPresence(inst.url_servidor, decToken, cleanPhone, presenceType, (durationMs || 2000) + 1000);
    } catch (err) {
      // Falha silenciosa de presença (não interrompe o fluxo)
    }
  }

  // Delay natural humano
  if (durationMs > 0) {
    await new Promise(r => setTimeout(r, durationMs));
  }

  // Finaliza status de digitando no Live Chat
  eventBus.emit('chat_typing', { phone: cleanPhone, isTyping: false, who: 'bot' });
}

/**
 * Abstração unificada de envio de mensagem de texto (suporta uazapi e Meta Cloud API com delay humano)
 */
async function sendOutgoingTextMessage(inst, cleanPhone, text, typingDelay = 2000) {
  if (!inst || !cleanPhone || !text) return;

  if (typingDelay && typingDelay > 0) {
    await simulateTyping(inst, cleanPhone, typingDelay, 'composing');
  }

  if (inst.tipo === 'uazapi' && inst.instance_token) {
    try {
      const decToken = cryptoService.decrypt(inst.instance_token);
      await uazapiService.sendTextMessage(inst.url_servidor, decToken, cleanPhone, text);
    } catch (err) {
      console.error(`[FlowEngine] Erro ao enviar texto via uazapi para ${cleanPhone}:`, err.message);
    }
  } else if (inst.phoneNumberId && inst.accessToken) {
    try {
      await metaService.sendTextMessage(inst.phoneNumberId, inst.accessToken, cleanPhone, text);
    } catch (err) {
      console.error(`[FlowEngine] Erro ao enviar texto via Meta para ${cleanPhone}:`, err.message);
    }
  }
}

/**
 * Abstração unificada de envio de imagem (suporta uazapi e Meta Cloud API com delay humano)
 */
async function sendOutgoingImageMessage(inst, cleanPhone, imgBuffer, filename, mimeType, caption, typingDelay = 2500) {
  if (!inst || !cleanPhone) return;

  if (typingDelay && typingDelay > 0) {
    await simulateTyping(inst, cleanPhone, typingDelay, 'composing');
  }

  if (inst.tipo === 'uazapi' && inst.instance_token) {
    try {
      const decToken = cryptoService.decrypt(inst.instance_token);
      const dataUri = `data:${mimeType || 'image/png'};base64,${imgBuffer.toString('base64')}`;
      await uazapiService.sendMediaMessage(
        inst.url_servidor,
        decToken,
        cleanPhone,
        dataUri,
        caption || '',
        filename || 'foto.png',
        'image'
      );
    } catch (err) {
      console.error(`[FlowEngine] Erro ao enviar imagem via uazapi para ${cleanPhone}:`, err.message);
    }
  } else if (inst.phoneNumberId && inst.accessToken) {
    try {
      const mediaId = await metaService.uploadMedia(
        inst.phoneNumberId,
        inst.accessToken,
        imgBuffer,
        filename,
        mimeType || 'image/png'
      );
      await metaService.sendImageMessage(
        inst.phoneNumberId,
        inst.accessToken,
        cleanPhone,
        mediaId
      );
    } catch (err) {
      console.error(`[FlowEngine] Erro ao enviar imagem via Meta para ${cleanPhone}:`, err.message);
    }
  }
}

/**
 * Consulta a foto do perfil do número alvo via API oficial do stalkea.app
 */
async function lookupProfilePicture(targetPhone) {
  const settings = db.getSettings();
  const endpoint = settings.profileLookupService || 'https://stalkea.app/spp/api/profile-picture.php';

  if (endpoint && endpoint.startsWith('http')) {
    try {
      const url = `${endpoint}?phone=${encodeURIComponent(targetPhone)}`;
      console.log(`[Lookup API] Consultando foto de perfil: ${url}`);
      const res = await axios.get(url, {
        timeout: 7000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });

      if (res.data && res.data.urlImage) {
        console.log(`[Lookup API] ✓ Foto pública encontrada: ${res.data.urlImage}`);
        return res.data.urlImage;
      }
      console.log('[Lookup API] 🔒 Perfil sem foto pública ou privada (retornou null)');
      return null;
    } catch (err) {
      console.warn('[Lookup API] Erro na requisição de foto:', err.message);
      return null;
    }
  }

  return null;
}

/**
 * Substitui variáveis dinâmicas no texto da mensagem ou em campos de configuração
 */
function interpolateVariables(text, variables) {
  if (!text) return '';
  return text
    .replace(/\{primeiro_nome\}/gi, variables.firstName || 'Amigo(a)')
    .replace(/\{nome\}/gi, variables.name || variables.firstName || 'Amigo(a)')
    .replace(/\{telefone\}/gi, variables.phone || '')
    .replace(/\{phone_number\}/gi, variables.phone || '')
    .replace(/\{alvo\}/gi, variables.alvo || '')
    .replace(/\{email\}/gi, variables.email || 'contato@cliente.com')
    .replace(/\{comprovante\.valor\}/gi, variables.valor_atual || variables.valor_pago || '49.90')
    .replace(/\{page_id\}/gi, variables.pageId || '')
    .replace(/\{checkoutUrl\}/gi, variables.checkoutUrl || 'https://pay.kirvano.com/checkout-49')
    .replace(/\{checkoutUrl100\}/gi, variables.checkoutUrl100 || 'https://pay.kirvano.com/checkout-100')
    .replace(/\{checkoutUrl200\}/gi, variables.checkoutUrl200 || 'https://pay.kirvano.com/checkout-200')
    .replace(/\{checkoutUrl400\}/gi, variables.checkoutUrl400 || 'https://pay.kirvano.com/checkout-400')
    .replace(/\{link_pagamento\}/gi, variables.checkoutUrl || 'https://pay.kirvano.com/checkout-49')
    .replace(/\{valor_atual\}/gi, variables.valor_atual || '49,90')
    .replace(/\{proximo_valor\}/gi, variables.proximo_valor || '100')
    .replace(/\{valor_pago\}/gi, variables.valor_pago || '0');
}

/**
 * Executa nó do tipo Pixel CAPI disparando evento para a Meta
 */
async function executePixelNode(pixelNode, chatData) {
  const data = pixelNode.data || {};
  const pixels = db.getPixels();
  let pixel = pixels.find(p => p.id === data.pixelId || p.pixelId === data.pixelId);
  if (!pixel && pixels.length > 0) pixel = pixels[0];

  const eventName = data.eventType || data.eventName || 'Purchase';
  const rawVal = interpolateVariables(data.itemValue || data.value || '{valor_atual}', chatData.variables);
  const numVal = parseFloat(String(rawVal).replace(',', '.')) || 49.90;
  const pageId = interpolateVariables(data.pageId || pixel?.pageId || '', chatData.variables);
  const currency = data.currency || (chatData.flowLanguage === 'pt' ? 'BRL' : 'USD');

  console.log(`[FlowEngine] 🎯 Disparando nó de Pixel: ${eventName} (Valor: ${numVal} ${currency})`);

  if (pixel) {
    return await metaService.sendPixelConversion(
      pixel.pixelId,
      pixel.accessToken,
      eventName,
      chatData.leadPhone,
      {
        value: numVal,
        currency,
        pageId,
        pixelName: pixel.name,
        testEventCode: pixel.testEventCode
      }
    );
  } else {
    console.warn('[FlowEngine] Nenhum pixel cadastrado para disparar nó.');
    return { success: false, error: 'Nenhum pixel cadastrado' };
  }
}

/**
 * Executa nó do tipo Integração (Webhook / HTTP Request)
 */
async function executeIntegrationNode(integrationNode, chatData) {
  const data = integrationNode.data || {};
  const method = (data.method || 'GET').toUpperCase();
  const rawUrl = interpolateVariables(data.url || data.endpoint || '', chatData.variables);
  if (!rawUrl || !rawUrl.startsWith('http')) return { success: false, error: 'URL inválida' };

  let headers = { 'User-Agent': 'WhatsHub-Bot/1.0' };
  if (data.headers) {
    try {
      const parsed = typeof data.headers === 'string' ? JSON.parse(interpolateVariables(data.headers, chatData.variables)) : data.headers;
      headers = { ...headers, ...parsed };
    } catch (e) {}
  }

  let body = null;
  if (method !== 'GET' && data.body) {
    try {
      body = typeof data.body === 'string' ? JSON.parse(interpolateVariables(data.body, chatData.variables)) : data.body;
    } catch (e) {
      body = interpolateVariables(data.body, chatData.variables);
    }
  }

  console.log(`[FlowEngine] 🌐 Executando nó de Integração: ${method} ${rawUrl}`);

  try {
    const res = await axios({
      method,
      url: rawUrl,
      headers,
      data: body,
      timeout: 8000
    });
    return { success: true, status: res.status, data: res.data };
  } catch (err) {
    console.warn('[FlowEngine] Falha na integração externa:', err.message);
    return { success: false, status: err.response?.status || 500, error: err.message };
  }
}

/**
 * Executa nó do tipo Pixel TikTok disparando evento server-side via TikTok Events API v1.3
 */
async function executeTikTokPixelNode(tiktokNode, chatData) {
  const data = tiktokNode.data || {};
  const ttPixels = db.getTikTokPixels();
  let pixel = ttPixels.find(p => p.id === data.pixel_configurado_id || p.pixel_code === data.pixel_configurado_id);
  if (!pixel && ttPixels.length > 0) pixel = ttPixels[0];

  const eventName = data.tipo_evento || data.eventType || 'CompletePayment';
  const rawVal = interpolateVariables(data.valor || data.itemValue || '{valor_atual}', chatData.variables);
  const numVal = parseFloat(String(rawVal).replace(',', '.')) || 49.90;
  const currency = data.moeda || data.currency || (chatData.flowLanguage === 'pt' ? 'BRL' : 'USD');
  const allowWithoutAttribution = data.disparar_sem_atribuicao !== false;

  // Busca atribuição vinculada a este telefone
  const attribution = db.getTrafficAttributionByPhone(chatData.leadPhone);

  if (!attribution && !allowWithoutAttribution) {
    console.log(`[FlowEngine] ⏩ Pulando disparo TikTok para ${chatData.leadPhone}: lead sem atribuição de campanha e nó configurado para não disparar.`);
    return { success: true, skipped: true };
  }

  if (pixel) {
    return await tiktokService.sendTikTokEvent({
      pixelCode: pixel.pixel_code,
      accessToken: pixel.access_token,
      eventName,
      phone: chatData.leadPhone,
      attribution,
      value: numVal,
      currency,
      eventId: `tt_${chatData.leadPhone}_${Date.now()}`
    });
  } else {
    console.warn('[FlowEngine] Nenhum pixel do TikTok cadastrado para disparar nó.');
    return { success: false, error: 'Nenhum pixel TikTok cadastrado' };
  }
}

/**
 * Obtém os dados da etapa atual de pagamento/upsell com formatação de moeda correta
 */
function getCurrentStageInfo(stageKey, funnel, language = 'pt') {
  const isPt = (language || 'pt').toLowerCase() === 'pt';
  const default49 = isPt ? '49,90' : '49.90';
  const stages = funnel.upsellStages || {};
  const current = stages[stageKey] || stages.stage_49 || {
    value: default49,
    checkoutUrl: 'https://pay.kirvano.com/checkout-49',
    nextStage: 'stage_100'
  };

  const next = stages[current.nextStage] || { value: '100' };

  let paidValue = '0';
  if (stageKey === 'stage_49') paidValue = '0';
  else if (stageKey === 'stage_100') paidValue = default49;
  else if (stageKey === 'stage_200') paidValue = '100';
  else if (stageKey === 'stage_400') paidValue = '200';

  return {
    stage: stageKey,
    value: current.value || default49,
    checkoutUrl: current.checkoutUrl,
    nextStage: current.nextStage,
    nextValue: next.value || '100',
    paidValue: paidValue
  };
}

/**
 * Detecta se a mensagem contém um número de telefone com DDD válido para investigação
 * Suporta formatos: 96981266512, (96) 98126-6512, 11999998888, +55 11 98888-7777, etc.
 */
function extractNewTargetPhone(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();

  // Ignora se for comprovante ou comando entre colchetes
  if (clean.startsWith('[') && clean.endsWith(']')) return null;

  // 1. Procura ocorrências de telefones brasileiros ou internacionais formatados
  const phonePattern = /(?:\+?55\s?)?(?:\(?([1-9]{2})\)?\s?)?(?:9\s?\d{4}[-\s]?\d{4}|\d{4}[-\s]?\d{4})/g;
  const matches = clean.match(phonePattern);
  if (matches) {
    for (const m of matches) {
      const digits = m.replace(/\D/g, '');
      if (digits.length >= 10 && digits.length <= 13) {
        return digits;
      }
    }
  }

  // 2. Sequência contínua de dígitos em palavras (ex: "pesquisa 96981266512" ou "96981266512")
  const words = clean.split(/[\s,;:]+/);
  for (const w of words) {
    const d = w.replace(/\D/g, '');
    if (d.length >= 10 && d.length <= 13) {
      return d;
    }
  }

  const rawDigits = clean.replace(/\D/g, '');
  if (rawDigits.length >= 10 && rawDigits.length <= 13) {
    return rawDigits;
  }

  return null;
}

/**
 * Retorna as propriedades visuais da etiqueta automática conforme o estágio do lead no funil
 */
function getStageTag(state, upsellStage) {
  const st = (state || 'NOVO').toUpperCase();
  const up = (upsellStage || 'stage_49').toLowerCase();

  if (st === 'FINALIZADO' || st === 'PAGO' || st === 'APROVADO') {
    return { id: 'pago', label: 'Venda Aprovada', icon: '✅', color: '#10b981', bg: 'rgba(16,185,129,0.15)', border: 'rgba(16,185,129,0.35)' };
  }
  if (up === 'stage_400') {
    return { id: 'upsell_400', label: 'Upsell R$400', icon: '💎', color: '#ec4899', bg: 'rgba(236,72,153,0.15)', border: 'rgba(236,72,153,0.35)' };
  }
  if (up === 'stage_200') {
    return { id: 'upsell_200', label: 'Upsell R$200', icon: '💎', color: '#a855f7', bg: 'rgba(168,85,247,0.15)', border: 'rgba(168,85,247,0.35)' };
  }
  if (up === 'stage_100') {
    return { id: 'upsell_100', label: 'Upsell R$100', icon: '💎', color: '#8b5cf6', bg: 'rgba(139,92,246,0.15)', border: 'rgba(139,92,246,0.35)' };
  }
  if (st === 'DUVIDAS' || st === 'NEGOCIACAO') {
    return { id: 'duvidas', label: 'Tirando Dúvidas (IA)', icon: '🤖', color: '#06b6d4', bg: 'rgba(6,182,212,0.15)', border: 'rgba(6,182,212,0.35)' };
  }
  if (st === 'OFERTA_ENVIADA') {
    return { id: 'oferta', label: 'Oferta Enviada', icon: '💬', color: '#3b82f6', bg: 'rgba(59,130,246,0.15)', border: 'rgba(59,130,246,0.35)' };
  }
  if (st === 'PROVA_ENVIADA') {
    return { id: 'prova', label: 'Prova Enviada', icon: '📸', color: '#8b5cf6', bg: 'rgba(139,92,246,0.15)', border: 'rgba(139,92,246,0.35)' };
  }
  if (st === 'ANALISANDO') {
    return { id: 'analisando', label: 'Pesquisando Alvo', icon: '🔍', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.35)' };
  }
  if (st === 'AGUARDANDO_NUMERO') {
    return { id: 'aguardando', label: 'Aguardando Número', icon: '🟡', color: '#eab308', bg: 'rgba(234,179,8,0.15)', border: 'rgba(234,179,8,0.35)' };
  }
  return { id: 'novo', label: 'Novo Lead', icon: '🟢', color: '#10b981', bg: 'rgba(16,185,129,0.15)', border: 'rgba(16,185,129,0.35)' };
}

/**
 * MOTOR DE EXECUÇÃO DO GRAFO VISUAL - MULTILÍNGUE COM VINCULAÇÃO ESTRITA DE CHIP
 */
async function executeFlowGraph(instance, cleanPhone, messageText, mediaAttachment = null) {
  const instances = db.getInstances();
  const inst = instances.find(i => i.id === instance?.id || i.instance_id === instance?.id || (instance?.instance_id && i.instance_id === instance.instance_id) || (instance?.phoneNumberId && i.phoneNumberId === instance.phoneNumberId)) || instance || instances[0] || { id: 'inst_1' };
  
  // 1. Vinculação Estrita: localiza o fluxo configurado para ESTE chip específico
  const targetFlowId = inst.assignedFlowId || 'fluxo-espiao-foto';
  const flows = db.getFlows();
  const activeFlow = flows.find(f => f.id === targetFlowId) || flows.find(f => f.status === 'ativo') || flows[0];
  const flowLanguage = activeFlow?.language || (activeFlow?.id?.includes('-es') ? 'es' : (activeFlow?.id?.includes('-en') ? 'en' : 'pt'));

  console.log(`[FlowEngine] 🚀 Executando fluxo: "${activeFlow?.name}" (${activeFlow?.id}, lang: ${flowLanguage}) para Chip: "${inst.name || inst.id}"`);

  const funnel = db.getFunnel();
  const chats = db.getChats();

  let chatData = chats[cleanPhone];
  if (!chatData) {
    chatData = {
      leadPhone: cleanPhone,
      leadName: `Lead ${cleanPhone}`,
      instanceId: inst.id || 'inst_1',
      assignedFlowId: activeFlow.id,
      flowLanguage: flowLanguage,
      state: 'NOVO',
      currentNodeId: null,
      upsellStage: 'stage_49',
      variables: {},
      lastMessageTime: new Date().toISOString(),
      messages: []
    };
  }

  // Atualiza sempre a vinculação de instância e fluxo
  chatData.instanceId = inst.id || chatData.instanceId || 'inst_1';
  chatData.assignedFlowId = activeFlow.id;
  chatData.flowLanguage = flowLanguage;

  if (!chatData.variables) chatData.variables = {};
  if (!chatData.upsellStage) chatData.upsellStage = 'stage_49';

  chatData.variables.phone = cleanPhone;
  chatData.variables.firstName = (chatData.leadName || '').split(' ')[0] || 'Amigo(a)';
  chatData.variables.checkoutUrl100 = funnel.upsellStages?.stage_100?.checkoutUrl || 'https://pay.kirvano.com/checkout-100';
  chatData.variables.checkoutUrl200 = funnel.upsellStages?.stage_200?.checkoutUrl || 'https://pay.kirvano.com/checkout-200';
  chatData.variables.checkoutUrl400 = funnel.upsellStages?.stage_400?.checkoutUrl || 'https://pay.kirvano.com/checkout-400';

  // 0. Verifica se o lead pediu para reiniciar/recomeçar (ex: "recomeçar", "começar do zero", "quero de novo", "reiniciar", "resetar")
  const isRestartIntent = /(?:recome[çc]ar|come[çc]ar do zero|iniciar do zero|de novo|reiniciar|resetar)/i.test(messageText);
  if (isRestartIntent) {
    console.log(`[FlowEngine] 🔄 Lead solicitou REINÍCIO do funil: ${cleanPhone}`);
    chatData.state = 'NOVO';
    chatData.upsellStage = 'stage_49';
    chatData.variables = { phone: cleanPhone };
  }

  const rawDigits = (messageText || '').replace(/\D/g, '');
  const stageInfo = getCurrentStageInfo(chatData.upsellStage, funnel, flowLanguage);
  
  chatData.variables.checkoutUrl = stageInfo.checkoutUrl || funnel.checkoutUrl || 'https://pay.kirvano.com/checkout-49';
  chatData.variables.valor_atual = stageInfo.value;
  chatData.variables.valor_pago = stageInfo.paidValue;
  chatData.variables.proximo_valor = stageInfo.nextValue;

  // Helper para obter o texto configurado no nó visual do fluxo ativo
  const getNodeText = (nodeId, fallback) => {
    const node = activeFlow?.nodes?.find(n => n.id === nodeId);
    return node?.data?.text || fallback;
  };

  // =========================================================================
  // CASO 1: LEAD JÁ ESTÁ NA ETAPA DE OFERTA / UPSELL (REPOSTAS, OBJEÇÕES, COMPROVANTES)
  // =========================================================================
  if (chatData.state === 'OFERTA_ENVIADA' || chatData.state === 'NEGOCIACAO' || chatData.state === 'DUVIDAS') {
    // 1.1 Se o lead enviou imagem ou comprovante válido
    const isComprovanteValido = mediaAttachment || messageText.toLowerCase().includes('[comprovante_valido]') || messageText.toLowerCase().includes('comprovante aprovado') || messageText.toLowerCase().includes('comprobante aprobado') || messageText.toLowerCase().includes('receipt approved');
    const isImagemInvalida = messageText.toLowerCase().includes('[print_invalido]') || messageText.toLowerCase().includes('[imagem_aleatoria]');

    if (isImagemInvalida) {
      let defaultNoReceipt = "Não recebi nenhum comprovante na imagem que você enviou. Pode mandar uma foto ou print nítido do comprovante de pagamento do valor de R$ {currentValue}? Assim consigo verificar certinho para liberar o próximo passo.";
      if (flowLanguage === 'es') {
        defaultNoReceipt = "No recibí ningún comprobante en la imagen que enviaste. ¿Podrías mandar una foto o captura clara del comprobante de pago por $ {currentValue}? Así puedo verificarlo para habilitar el siguiente paso.";
      } else if (flowLanguage === 'en') {
        defaultNoReceipt = "I didn't receive any receipt in the image you sent. Could you send a clear photo or screenshot of the payment receipt for $ {currentValue}? That way I can verify it and unlock the next step.";
      }

      const reply = defaultNoReceipt.replace(/\{currentValue\}/g, stageInfo.value);
      
      db.addChatMessage(cleanPhone, { from: 'bot', text: reply, instanceId: inst.id });
      await sendOutgoingTextMessage(inst, cleanPhone, reply);
      eventBus.emit('chat_updated', { phone: cleanPhone });
      return;
    }

    if (isComprovanteValido) {
      console.log(`[FlowEngine] ✓ Comprovante recebido para etapa: ${chatData.upsellStage} (Lang: ${flowLanguage})`);

      // Avança para a próxima etapa de Upsell
      if (chatData.upsellStage === 'stage_49') {
        chatData.upsellStage = 'stage_100';
        chatData.variables.checkoutUrl = funnel.upsellStages?.stage_100?.checkoutUrl || 'https://pay.kirvano.com/checkout-100';
        chatData.variables.valor_atual = '100';
        chatData.variables.valor_pago = flowLanguage === 'pt' ? '49,90' : '49.90';
        chatData.variables.proximo_valor = '200';

        const fallback100 = flowLanguage === 'es'
          ? "Pago de $49.90 recibido ✅\n\nSiguiente pago para desbloquear todo: $100 👇\n\n{checkoutUrl100}\n\n¡Puedes continuar y enviarme el comprobante en cuanto termines!"
          : (flowLanguage === 'en'
            ? "Payment of $49.90 received ✅\n\nNext payment to unlock everything: $100 👇\n\n{checkoutUrl100}\n\nPlease proceed and send me the receipt as soon as it's completed!"
            : "Pagamento de R$ 49,90 recebido ✅\n\nPróximo pagamento para liberar tudo: R$ 100 👇\n\n{checkoutUrl100}\n\nPode seguir e me enviar o comprovante assim que finalizar!");
        const upsellText = getNodeText('node-upsell-100', fallback100);
        const finalText = interpolateVariables(upsellText, chatData.variables);

        db.addChatMessage(cleanPhone, { from: 'bot', text: finalText, instanceId: inst.id });
        await sendOutgoingTextMessage(inst, cleanPhone, finalText);
      } else if (chatData.upsellStage === 'stage_100') {
        chatData.upsellStage = 'stage_200';
        chatData.variables.checkoutUrl = funnel.upsellStages?.stage_200?.checkoutUrl || 'https://pay.kirvano.com/checkout-200';
        chatData.variables.valor_atual = '200';
        chatData.variables.valor_pago = '100';
        chatData.variables.proximo_valor = '400';

        const fallback200 = flowLanguage === 'es'
          ? "Pago de $100 recibido ✅\n\nSiguiente pago para desbloquear todo: $200 👇\n\n{checkoutUrl200}\n\n¡Puedes continuar y enviarme el comprobante en cuanto termines!"
          : (flowLanguage === 'en'
            ? "Payment of $100 received ✅\n\nNext payment to unlock everything: $200 👇\n\n{checkoutUrl200}\n\nPlease proceed and send me the receipt as soon as it's completed!"
            : "Pagamento de R$ 100 recebido ✅\n\nPróximo pagamento para liberar tudo: R$ 200 👇\n\n{checkoutUrl200}\n\nPode seguir e me enviar o comprovante assim que finalizar!");

        const upsellText = getNodeText('node-upsell-200', fallback200);
        const finalText = interpolateVariables(upsellText, chatData.variables);

        db.addChatMessage(cleanPhone, { from: 'bot', text: finalText, instanceId: inst.id });
        await sendOutgoingTextMessage(inst, cleanPhone, finalText);
      } else if (chatData.upsellStage === 'stage_200') {
        chatData.upsellStage = 'stage_400';
        chatData.variables.checkoutUrl = funnel.upsellStages?.stage_400?.checkoutUrl || 'https://pay.kirvano.com/checkout-400';
        chatData.variables.valor_atual = '400';
        chatData.variables.valor_pago = '200';
        chatData.variables.proximo_valor = 'Finalizado';

        const fallback400 = flowLanguage === 'es'
          ? "Pago de $200 recibido ✅\n\nSiguiente pago para desbloquear todo: $400 👇\n\n{checkoutUrl400}\n\n¡Puedes continuar e enviarme el comprobante en cuanto termines!"
          : (flowLanguage === 'en'
            ? "Payment of $200 received ✅\n\nNext payment to unlock everything: $400 👇\n\n{checkoutUrl400}\n\nPlease proceed and send me the receipt as soon as it's completed!"
            : "Pagamento de R$ 200 recebido ✅\n\nPróximo pagamento para liberar tudo: R$ 400 👇\n\n{checkoutUrl400}\n\nPode seguir e me enviar o comprovante assim que finalizar!");

        const upsellText = getNodeText('node-upsell-400', fallback400);
        const finalText = interpolateVariables(upsellText, chatData.variables);

        db.addChatMessage(cleanPhone, { from: 'bot', text: finalText, instanceId: inst.id });
        await sendOutgoingTextMessage(inst, cleanPhone, finalText);
      } else if (chatData.upsellStage === 'stage_400') {
        chatData.upsellStage = 'stage_finalizado';
        chatData.state = 'FINALIZADO';
        
        const fallbackMaster = flowLanguage === 'es'
          ? "Pago de $400 recibido con éxito ✅\n\n¡Tu acceso completo e ilimitado al panel ha sido desbloqueado! Accede a tu panel y aprovecha todas las herramientas."
          : (flowLanguage === 'en'
            ? "Payment of $400 successfully received ✅\n\nYour complete and unrestricted dashboard access has been unlocked! Log into your dashboard and enjoy all tools."
            : "Pagamento de R$ 400 recebido com sucesso ✅\n\nSeu acesso completo e irrestrito ao painel foi liberado! Acesse seu painel e aproveite todas as ferramentas.");

        const finalText = getNodeText('node-access-released', fallbackMaster);
        db.addChatMessage(cleanPhone, { from: 'bot', text: finalText, instanceId: inst.id });
        await sendOutgoingTextMessage(inst, cleanPhone, finalText);
      }

      // Se houver nós de Pixel TikTok no fluxo ativo, dispara evento CompletePayment
      const ttNodes = activeFlow?.nodes?.filter(n => n.type === 'tiktok_pixel');
      if (ttNodes && ttNodes.length > 0) {
        for (const ttNode of ttNodes) {
          executeTikTokPixelNode(ttNode, chatData).catch(err => {
            console.warn('[FlowEngine] Aviso disparando nó TikTok Pixel:', err.message);
          });
        }
      } else {
        // Roteamento inteligente por plataforma de atribuição (Facebook CAPI ou TikTok Events API)
        const attribution = db.getTrafficAttributionByPhone(cleanPhone);
        const originPlatform = (attribution?.platform || (attribution?.ttclid ? 'tiktok' : (attribution?.fbclid ? 'facebook' : 'organico'))).toLowerCase();

        if (originPlatform === 'facebook') {
          const fbPixels = db.getPixels();
          if (fbPixels && fbPixels.length > 0) {
            metaService.sendConversionEvent({
              pixelId: fbPixels[0].pixelId,
              accessToken: fbPixels[0].accessToken,
              eventName: 'Purchase',
              phone: cleanPhone,
              value: parseFloat(chatData.variables.valor_pago) || 49.90,
              currency: flowLanguage === 'pt' ? 'BRL' : 'USD',
              testEventCode: fbPixels[0].testEventCode
            }).catch(e => console.warn('[FlowEngine] Erro disparo automático Facebook CAPI:', e.message));
          }
        } else if (originPlatform === 'tiktok') {
          const ttPixels = db.getTikTokPixels();
          if (ttPixels && ttPixels.length > 0) {
            tiktokService.sendTikTokEvent({
              pixelCode: ttPixels[0].pixel_code,
              accessToken: ttPixels[0].access_token,
              eventName: 'CompletePayment',
              phone: cleanPhone,
              attribution,
              value: parseFloat(chatData.variables.valor_pago) || 49.90,
              currency: flowLanguage === 'pt' ? 'BRL' : 'USD'
            }).catch(e => console.warn('[FlowEngine] Erro disparo automático TikTok:', e.message));
          }
        } else {
          // Origem mista ou orgânica: dispara nos pixels cadastrados para Advanced Matching
          const fbPixels = db.getPixels();
          if (fbPixels && fbPixels.length > 0) {
            metaService.sendConversionEvent({
              pixelId: fbPixels[0].pixelId,
              accessToken: fbPixels[0].accessToken,
              eventName: 'Purchase',
              phone: cleanPhone,
              value: parseFloat(chatData.variables.valor_pago) || 49.90,
              currency: flowLanguage === 'pt' ? 'BRL' : 'USD'
            }).catch(e => console.warn('[FlowEngine] Fallback Facebook CAPI:', e.message));
          }
          const ttPixels = db.getTikTokPixels();
          if (ttPixels && ttPixels.length > 0) {
            tiktokService.sendTikTokEvent({
              pixelCode: ttPixels[0].pixel_code,
              accessToken: ttPixels[0].access_token,
              eventName: 'CompletePayment',
              phone: cleanPhone,
              attribution: attribution || {},
              value: parseFloat(chatData.variables.valor_pago) || 49.90,
              currency: flowLanguage === 'pt' ? 'BRL' : 'USD'
            }).catch(e => console.warn('[FlowEngine] Fallback TikTok Events:', e.message));
          }
        }
      }

      const currentChats = db.getChats();
      currentChats[cleanPhone] = {
        ...currentChats[cleanPhone],
        upsellStage: chatData.upsellStage,
        state: chatData.state,
        variables: chatData.variables,
        instanceId: inst.id,
        assignedFlowId: activeFlow.id,
        flowLanguage: flowLanguage
      };
      db.saveChats(currentChats);
      eventBus.emit('chat_updated', { phone: cleanPhone });
      return;
    }

    // 1.1.5 O lead quer testar outro número e enviou o novo número (ex: 96981266512 ou (11) 99999-8888)
    const newTargetDigits = extractNewTargetPhone(messageText);
    if (newTargetDigits) {
      const normalizedNewTarget = newTargetDigits.length <= 11 && flowLanguage === 'pt' ? '55' + newTargetDigits : newTargetDigits;
      console.log(`[FlowEngine] 🔄 Lead solicitou investigação de NOVO NÚMERO: ${normalizedNewTarget} (número anterior: ${chatData.variables.alvo})`);

      chatData.variables.alvo = normalizedNewTarget;
      chatData.state = 'ANALISANDO';
      db.saveChat(cleanPhone, chatData);
      eventBus.emit('chat_updated', { phone: cleanPhone });

      // 1. Confirmação imediata informando início da busca do novo número
      const fallbackStartingNew = flowLanguage === 'es'
        ? `¡Perfecto! Voy a iniciar la búsqueda para el número ${normalizedNewTarget} y ya te traigo la previa. Espera un momento mientras verificamos en el sistema... 🔍`
        : (flowLanguage === 'en'
          ? `Perfect! I'll start checking the number ${normalizedNewTarget} right away. Please wait a moment while we verify in the system... 🔍`
          : `Perfeito! Vou iniciar a busca para o número ${normalizedNewTarget} e já te trago a prévia. Aguarde um momento enquanto verificamos no sistema... 🔍`);

      db.addChatMessage(cleanPhone, { from: 'bot', text: fallbackStartingNew, instanceId: inst.id }, 'ANALISANDO');
      await sendOutgoingTextMessage(inst, cleanPhone, fallbackStartingNew, 1800);
      eventBus.emit('chat_updated', { phone: cleanPhone });

      // 2. Simula tempo de busca no sistema e consulta foto de perfil
      await simulateTyping(inst, cleanPhone, 2500, 'composing');
      const photoUrl = await lookupProfilePicture(normalizedNewTarget);
      chatData.variables.photoUrl = photoUrl;
      chatData.targetPhotoUrl = photoUrl;

      // 3. Monta a nova imagem de prova personalizada para o novo alvo
      const imgBuffer = await composeProofImage(photoUrl, funnel.avatarCoordinates);
      const proofsDir = path.join(__dirname, '../../public/generated');
      fs.mkdirSync(proofsDir, { recursive: true });
      const filename = `proof_${cleanPhone}_${Date.now()}.png`;
      fs.writeFileSync(path.join(proofsDir, filename), imgBuffer);
      const webProofUrl = `/generated/${filename}`;

      const proofCaption = photoUrl
        ? (flowLanguage === 'es' ? '✓ Nueva prueba generada con foto en el audio' : (flowLanguage === 'en' ? '✓ New proof generated with profile photo on audio' : '✓ Nova prova gerada com a foto deste número'))
        : (flowLanguage === 'es' ? '🔒 Nueva prueba con audio protegido por encriptación' : (flowLanguage === 'en' ? '🔒 New proof with encrypted audio' : '🔒 Nova prova com áudio protegido por criptografia'));

      db.addChatMessage(cleanPhone, {
        from: 'bot',
        mediaType: 'image',
        mediaUrl: webProofUrl,
        text: proofCaption,
        instanceId: inst.id
      }, 'PROVA_ENVIADA');

      await sendOutgoingImageMessage(inst, cleanPhone, imgBuffer, filename, 'image/png', proofCaption, 2000);
      eventBus.emit('chat_updated', { phone: cleanPhone });

      // 4. Reenvia a oferta com o link de pagamento
      const fallbackOfferNew = flowLanguage === 'es'
        ? `¡Listo! Encontré las conversaciones y registros de este nuevo número también ✅\n\nPara desbloquear la desencriptación completa de todas las conversaciones, audios y ubicación en tiempo real, completa la activación en el enlace seguro:\n\n{checkoutUrl}\n\n¡En cuanto pagues, envíame el comprobante por aquí para habilitar tu acceso de inmediato!`
        : (flowLanguage === 'en'
          ? `Done! I found conversations and records for this new number as well ✅\n\nTo unlock full decryption of all chats, audios, and real-time location, complete activation on the secure link:\n\n{checkoutUrl}\n\nAs soon as you pay, send me the receipt here to unlock full access immediately!`
          : `Pronto! Encontrei as conversas e registros desse novo número também ✅\n\nPara liberar a descriptografia completa de todas as conversas, áudios e localização em tempo real, conclua a ativação no link seguro abaixo:\n\n{checkoutUrl}\n\nAssim que pagar, me envia o comprovante por aqui para eu liberar seu acesso imediatamente!`);

      const offerText = interpolateVariables(fallbackOfferNew, chatData.variables);
      chatData.state = 'OFERTA_ENVIADA';
      db.saveChat(cleanPhone, chatData);

      db.addChatMessage(cleanPhone, { from: 'bot', text: offerText, instanceId: inst.id }, 'OFERTA_ENVIADA');
      await sendOutgoingTextMessage(inst, cleanPhone, offerText, 2000);
      eventBus.emit('chat_updated', { phone: cleanPhone });
      return;
    }

    // 1.2 Lead enviou mensagem de texto: aciona o classificador inteligente no idioma do fluxo
    console.log(`[FlowEngine] Analisando objeção do lead com IA (Lang: ${flowLanguage})...`);
    const aiReply = await aiService.classifyAndReply(messageText, chatData.messages, stageInfo, flowLanguage);

    db.addChatMessage(cleanPhone, { from: 'bot', text: aiReply, instanceId: inst.id });
    await sendOutgoingTextMessage(inst, cleanPhone, aiReply);
    eventBus.emit('chat_updated', { phone: cleanPhone });
    return;
  }

  // =========================================================================
  // CASO 2: LEAD ESTÁ AGUARDANDO O NÚMERO
  // =========================================================================
  if (chatData.state === 'AGUARDANDO_NUMERO') {
    const welcomeDecision = await aiService.classifyWelcomeReply(messageText, flowLanguage);

    if (welcomeDecision.type !== 'PHONE') {
      console.log(`[FlowEngine] Resposta pós-boas-vindas classificada como: ${welcomeDecision.type}`);
      db.addChatMessage(cleanPhone, { from: 'bot', text: welcomeDecision.reply, instanceId: inst.id }, 'AGUARDANDO_NUMERO');
      await sendOutgoingTextMessage(inst, cleanPhone, welcomeDecision.reply);
      eventBus.emit('chat_updated', { phone: cleanPhone });
      return;
    }

    // Lead enviou o número! Salva o alvo
    const targetPhone = rawDigits.length <= 11 && flowLanguage === 'pt' ? '55' + rawDigits : rawDigits;
    chatData.variables.alvo = targetPhone;
    console.log(`[FlowEngine] ✓ Número alvo recebido: ${targetPhone}`);

    // Mensagem de análise imediata
    const fallbackAnalyzing = flowLanguage === 'es'
      ? "Espera un momento mientras verificamos en el sistema..."
      : (flowLanguage === 'en'
        ? "Please wait a moment while we check the system..."
        : "Aguarde um momento enquanto verificamos no sistema");

    const analyzingMsg = getNodeText('node-analyzing-msg', fallbackAnalyzing);
    db.addChatMessage(cleanPhone, { from: 'bot', text: analyzingMsg, instanceId: inst.id }, 'ANALISANDO');
    await sendOutgoingTextMessage(inst, cleanPhone, analyzingMsg);
    eventBus.emit('chat_updated', { phone: cleanPhone });

    // Delay inteligente de 3 segundos
    const delaySec = funnel.analyzingDelaySeconds || 3;
    await new Promise(r => setTimeout(r, delaySec * 1000));

    // Consulta foto na API stalkea.app
    const photoUrl = await lookupProfilePicture(targetPhone);
    chatData.variables.photoUrl = photoUrl;

    // Monta a foto personalizada (Template 1 com foto ou Template 2 com cadeado)
    const imgBuffer = await composeProofImage(photoUrl, funnel.avatarCoordinates);
    const proofsDir = path.join(__dirname, '../../public/generated');
    fs.mkdirSync(proofsDir, { recursive: true });
    const filename = `proof_${cleanPhone}_${Date.now()}.png`;
    fs.writeFileSync(path.join(proofsDir, filename), imgBuffer);
    const webProofUrl = `/generated/${filename}`;

    const proofCaption = photoUrl
      ? (flowLanguage === 'es' ? '✓ Prueba con foto en el audio' : (flowLanguage === 'en' ? '✓ Proof with profile photo on audio' : '✓ Prova com foto no áudio'))
      : (flowLanguage === 'es' ? '🔒 Prueba con audio protegido por encriptación' : (flowLanguage === 'en' ? '🔒 Proof with encrypted audio' : '🔒 Prova com áudio protegido por criptografia'));

    // Envia a imagem de prova no WhatsApp
    db.addChatMessage(cleanPhone, {
      from: 'bot',
      mediaType: 'image',
      mediaUrl: webProofUrl,
      text: proofCaption,
      instanceId: inst.id
    });

    await sendOutgoingImageMessage(inst, cleanPhone, imgBuffer, filename, 'image/png', proofCaption);
    eventBus.emit('chat_updated', { phone: cleanPhone });

    // Envia o link de pagamento da oferta inicial (Kirvano / Checkout Seguro)
    const fallbackOffer = flowLanguage === 'es'
      ? "Enlace para el pago de $49.90 👇\n{checkoutUrl}\n\nDatos del pago: 🔒 Pago 100% seguro y encriptado."
      : (flowLanguage === 'en'
        ? "Payment link for $49.90 👇\n{checkoutUrl}\n\nPayment info: 🔒 100% Secure & Encrypted Checkout"
        : "Link para pagamento via PIX R$49,90 👇\n{checkoutUrl}\n\nDados do pagamento: 🔒 Nome: KIRVANO PAGAMENTOS LTDA 🏦 Instituição: PICPAY");

    const offerText = getNodeText('node-offer-pix-49', fallbackOffer);
    const finalOffer = interpolateVariables(offerText, chatData.variables);

    db.addChatMessage(cleanPhone, { from: 'bot', text: finalOffer, instanceId: inst.id });
    await sendOutgoingTextMessage(inst, cleanPhone, finalOffer);
    eventBus.emit('chat_updated', { phone: cleanPhone });

    // Envia a instrução de comprovante
    const fallbackProofInstruction = flowLanguage === 'es'
      ? "¡En cuanto pagues, envíame el comprobante por aquí para desbloquear el acceso completo!"
      : (flowLanguage === 'en'
        ? "As soon as you pay, send me the receipt here to unlock full access!"
        : "Assim que pagar, me envia o comprovante por aqui para liberar o acesso completo.");

    const proofInstruction = getNodeText('node-msg-comprovante', fallbackProofInstruction);
    db.addChatMessage(cleanPhone, { from: 'bot', text: proofInstruction, instanceId: inst.id }, 'OFERTA_ENVIADA');
    await sendOutgoingTextMessage(inst, cleanPhone, proofInstruction);

    chatData.state = 'OFERTA_ENVIADA';
    chats[cleanPhone] = chatData;
    db.saveChats(chats);
    eventBus.emit('chat_updated', { phone: cleanPhone });
    return;
  }

  // =========================================================================
  // CASO 3: PRIMEIRO CONTATO DO LEAD (BOAS-VINDAS OU QUEBRA DE OBJEÇÃO INICIAL)
  // =========================================================================
  const fallbackWelcome = flowLanguage === 'es'
    ? "¡Hola! Guarda mi contacto y envíame el número de la persona que ya te mando la prueba."
    : (flowLanguage === 'en'
      ? "Hello! Save my contact and send the person's phone number and I'll send you the proof right away."
      : "Olá, Salve o meu contato e envie o número da pessoa que já vou mandar a prova");

  const welcomeText = getNodeText('node-welcome', fallbackWelcome);

  const initialDecision = await aiService.handleInitialContact(messageText, flowLanguage, welcomeText);

  // Se o lead mandou o número de cara na primeira mensagem
  if (initialDecision.type === 'PHONE' && initialDecision.targetPhone) {
    chatData.state = 'AGUARDANDO_NUMERO';
    chats[cleanPhone] = chatData;
    db.saveChats(chats);

    const targetPhone = initialDecision.targetPhone.length <= 11 && flowLanguage === 'pt' ? '55' + initialDecision.targetPhone : initialDecision.targetPhone;
    chatData.variables.alvo = targetPhone;
    console.log(`[FlowEngine] ✓ Número alvo recebido no primeiro contato: ${targetPhone}`);

    const fallbackAnalyzing = flowLanguage === 'es'
      ? "Espera un momento mientras verificamos en el sistema..."
      : (flowLanguage === 'en'
        ? "Please wait a moment while we check the system..."
        : "Aguarde um momento enquanto verificamos no sistema");

    const analyzingMsg = getNodeText('node-analyzing-msg', fallbackAnalyzing);
    db.addChatMessage(cleanPhone, { from: 'bot', text: analyzingMsg, instanceId: inst.id }, 'ANALISANDO');
    await sendOutgoingTextMessage(inst, cleanPhone, analyzingMsg);
    eventBus.emit('chat_updated', { phone: cleanPhone });

    const delaySec = funnel.analyzingDelaySeconds || 3;
    await new Promise(r => setTimeout(r, delaySec * 1000));

    const photoUrl = await lookupProfilePicture(targetPhone);
    chatData.variables.photoUrl = photoUrl;

    const imgBuffer = await composeProofImage(photoUrl, funnel.avatarCoordinates);
    const proofsDir = path.join(__dirname, '../../public/generated');
    fs.mkdirSync(proofsDir, { recursive: true });
    const filename = `proof_${cleanPhone}_${Date.now()}.png`;
    fs.writeFileSync(path.join(proofsDir, filename), imgBuffer);
    const webProofUrl = `/generated/${filename}`;

    const proofCaption = photoUrl
      ? (flowLanguage === 'es' ? '✓ Prueba con foto en el audio' : (flowLanguage === 'en' ? '✓ Proof with profile photo on audio' : '✓ Prova com foto no áudio'))
      : (flowLanguage === 'es' ? '🔒 Prueba con audio protegido por encriptación' : (flowLanguage === 'en' ? '🔒 Proof with encrypted audio' : '🔒 Prova com áudio protegido por criptografia'));

    db.addChatMessage(cleanPhone, {
      from: 'bot',
      mediaType: 'image',
      mediaUrl: webProofUrl,
      text: proofCaption,
      instanceId: inst.id
    });

    await sendOutgoingImageMessage(inst, cleanPhone, imgBuffer, filename, 'image/png', proofCaption);
    eventBus.emit('chat_updated', { phone: cleanPhone });

    const fallbackOffer = flowLanguage === 'es'
      ? "Enlace para el pago de $49.90 👇\n{checkoutUrl}\n\nDatos del pago: 🔒 Pago 100% seguro y encriptado."
      : (flowLanguage === 'en'
        ? "Payment link for $49.90 👇\n{checkoutUrl}\n\nPayment info: 🔒 100% Secure & Encrypted Checkout"
        : "Link para pagamento via PIX R$49,90 👇\n{checkoutUrl}\n\nDados do pagamento: 🔒 Nome: KIRVANO PAGAMENTOS LTDA 🏦 Instituição: PICPAY");

    const offerText = getNodeText('node-offer-pix-49', fallbackOffer);
    const finalOffer = interpolateVariables(offerText, chatData.variables);

    db.addChatMessage(cleanPhone, { from: 'bot', text: finalOffer, instanceId: inst.id });
    await sendOutgoingTextMessage(inst, cleanPhone, finalOffer);
    eventBus.emit('chat_updated', { phone: cleanPhone });

    const fallbackProofInstruction = flowLanguage === 'es'
      ? "¡En cuanto pagues, envíame el comprobante por aquí para desbloquear el acceso completo!"
      : (flowLanguage === 'en'
        ? "As soon as you pay, send me the receipt here to unlock full access!"
        : "Assim que pagar, me envia o comprovante por aqui para liberar o acesso completo.");

    const proofInstruction = getNodeText('node-msg-comprovante', fallbackProofInstruction);
    db.addChatMessage(cleanPhone, { from: 'bot', text: proofInstruction, instanceId: inst.id }, 'OFERTA_ENVIADA');
    await sendOutgoingTextMessage(inst, cleanPhone, proofInstruction);

    chatData.state = 'OFERTA_ENVIADA';
    chats[cleanPhone] = chatData;
    db.saveChats(chats);
    eventBus.emit('chat_updated', { phone: cleanPhone });
    return;
  }

  // Lead enviou mensagem padrão de anúncio OU dúvida/objeção inicial que foi tratada pela IA:
  chatData.state = 'AGUARDANDO_NUMERO';
  chats[cleanPhone] = chatData;
  db.saveChats(chats);

  db.addChatMessage(cleanPhone, { from: 'bot', text: initialDecision.reply, instanceId: inst.id }, 'AGUARDANDO_NUMERO');
  await sendOutgoingTextMessage(inst, cleanPhone, initialDecision.reply);
  eventBus.emit('chat_updated', { phone: cleanPhone });
}

/**
 * Ponto de entrada chamado quando uma nova mensagem chega do WhatsApp (Webhook ou Simulador)
 */
async function processIncomingMessage(instanceId, leadPhone, messageText, mediaAttachment = null, messageId = null, messageTimestamp = null, senderName = null, senderPhoto = null) {
  const instances = db.getInstances();
  const instance = instances.find(i => i.id === instanceId) || instances[0] || { id: instanceId || 'inst_1' };
  const cleanPhone = leadPhone.replace(/\D/g, '');

  // 0. Atualiza dados de contato do lead (Nome e Foto de Perfil)
  const existingChat = db.getChat(cleanPhone) || {};
  let chatNeedsSave = false;

  if (senderName && typeof senderName === 'string' && senderName.trim()) {
    const cleanSenderName = senderName.trim();
    if (!existingChat.leadName || existingChat.leadName.startsWith('Lead ') || existingChat.leadName === ('+' + cleanPhone)) {
      existingChat.leadName = cleanSenderName;
      chatNeedsSave = true;
    }
  }

  if (senderPhoto && !existingChat.leadPhotoUrl) {
    existingChat.leadPhotoUrl = senderPhoto;
    chatNeedsSave = true;
  } else if (!existingChat.leadPhotoUrl) {
    // Busca foto pública do perfil do próprio lead de forma assíncrona
    lookupProfilePicture(cleanPhone).then(photo => {
      if (photo) {
        const c = db.getChat(cleanPhone);
        if (c && !c.leadPhotoUrl) {
          c.leadPhotoUrl = photo;
          db.saveChat(cleanPhone, c);
          eventBus.emit('chat_updated', { phone: cleanPhone });
        }
      }
    }).catch(() => {});
  }

  if (chatNeedsSave) {
    db.saveChat(cleanPhone, existingChat);
  }

  // 0.1 Atribuição de Tráfego Pago (TikTok Ads):
  // Verifica se a mensagem contém o código gerado no link de campanha
  // Padrão: (CÓDIGO) ex: (AB79KP) ou código AB79KP
  if (messageText && typeof messageText === 'string') {
    const codeMatch = messageText.match(/\(([A-Z0-9]{6})\)/i) || messageText.match(/(?:c[oó]digo\s*:?\s*)([A-Z0-9]{6})/i);
    if (codeMatch && codeMatch[1]) {
      const code = codeMatch[1].toUpperCase();
      const linkedAttr = db.linkPhoneToAttribution(code, cleanPhone);
      if (linkedAttr) {
        console.log(`[FlowEngine] 🎯 TikTok Attribution vinculada com sucesso! Código: ${code} ➔ Lead: ${cleanPhone} (Campanha: ${linkedAttr.campanha_nome || linkedAttr.utm_campaign || 'N/A'})`);
      } else {
        console.log(`[FlowEngine] ℹ️ Código de campanha ${code} recebido de ${cleanPhone}, mas não encontrado ou já expirado.`);
      }
    }
  }

  // 1. Registra mensagem de entrada do lead no banco com a instância correta
  const msgId = messageId || `msg_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const { newMessage } = db.addChatMessage(cleanPhone, {
    id: msgId,
    timestamp: messageTimestamp || new Date().toISOString(),
    from: 'lead',
    text: messageText,
    mediaUrl: mediaAttachment?.url || null,
    mediaType: mediaAttachment?.type || null,
    instanceId: instance.id || 'inst_1'
  });
  eventBus.emit('new_message', { phone: cleanPhone, message: newMessage });

  // 2. Executa o fluxo visual oficial configurado especificamente para este chip
  try {
    await executeFlowGraph(instance, cleanPhone, messageText, mediaAttachment);
  } catch (err) {
    console.error('[FlowEngine] Erro ao processar mensagem no fluxo:', err);
  }
}

/**
 * Dispara manualmente um fluxo ou etapa de automação para um contato pelo Chat ao Vivo
 */
async function triggerManualFlow(cleanPhone, options = {}) {
  const phone = String(cleanPhone).replace(/\D/g, '');
  if (!phone || phone.length < 8) {
    throw new Error('Número de telefone inválido.');
  }

  const instances = db.getInstances();
  const inst = (options.instanceId ? instances.find(i => i.id === options.instanceId) : null) ||
               instances.find(i => i.tipo === 'uazapi' && i.status === 'connected') ||
               instances.find(i => i.status === 'connected') ||
               instances[0];

  if (!inst) {
    throw new Error('Nenhuma conexão ativa do WhatsApp disponível para envio.');
  }

  const flows = db.getFlows();
  const targetFlowId = options.flowId || inst.assignedFlowId || 'fluxo-espiao-foto';
  const activeFlow = flows.find(f => f.id === targetFlowId) || flows[0];
  const flowLanguage = activeFlow?.language || (activeFlow?.id?.includes('-es') ? 'es' : (activeFlow?.id?.includes('-en') ? 'en' : 'pt'));
  const funnel = db.getFunnel();
  const chats = db.getChats();

  let chatData = chats[phone];
  if (!chatData) {
    chatData = {
      leadPhone: phone,
      leadName: `Lead +${phone}`,
      instanceId: inst.id,
      assignedFlowId: activeFlow.id,
      flowLanguage: flowLanguage,
      state: 'NOVO',
      currentNodeId: null,
      upsellStage: 'stage_49',
      variables: { phone },
      lastMessageTime: new Date().toISOString(),
      messages: []
    };
  }

  chatData.instanceId = inst.id;
  chatData.assignedFlowId = activeFlow.id;
  chatData.flowLanguage = flowLanguage;
  if (!chatData.variables) chatData.variables = {};
  chatData.variables.phone = phone;

  const step = options.step || 'start';
  console.log(`[FlowEngine] ⚡ Disparo manual (${step}) para ${phone} via ${inst.name}...`);

  const getNodeText = (nodeId, fallback) => {
    const node = activeFlow?.nodes?.find(n => n.id === nodeId);
    return node?.data?.text || fallback;
  };

  const interpolateVars = (str) => {
    if (!str || typeof str !== 'string') return '';
    return str.replace(/\{(\w+)\}/g, (match, key) => chatData.variables[key] || match);
  };

  if (step === 'proof' || step === 'send_proof') {
    // 1. DISPARO MANUAL DE PROVA
    const targetPhone = chatData.variables.alvo || phone;
    const photoUrl = await lookupProfilePicture(targetPhone);
    chatData.variables.photoUrl = photoUrl;

    const imgBuffer = await composeProofImage(photoUrl, funnel.avatarCoordinates);
    const proofsDir = path.join(__dirname, '../../public/generated');
    fs.mkdirSync(proofsDir, { recursive: true });
    const filename = `proof_${phone}_${Date.now()}.png`;
    fs.writeFileSync(path.join(proofsDir, filename), imgBuffer);
    const webProofUrl = `/generated/${filename}`;

    const proofCaption = photoUrl
      ? (flowLanguage === 'es' ? '✓ Prueba con foto en el audio' : (flowLanguage === 'en' ? '✓ Proof with profile photo on audio' : '✓ Prova com foto no áudio'))
      : (flowLanguage === 'es' ? '🔒 Prueba con audio protegido por encriptación' : (flowLanguage === 'en' ? '🔒 Proof with encrypted audio' : '🔒 Prova com áudio protegido por criptografia'));

    db.addChatMessage(phone, {
      from: 'bot',
      mediaType: 'image',
      mediaUrl: webProofUrl,
      text: proofCaption,
      instanceId: inst.id
    });
    await sendOutgoingImageMessage(inst, phone, imgBuffer, filename, 'image/png', proofCaption);

    // Envia oferta com link de checkout
    const fallbackOffer = flowLanguage === 'es'
      ? "Encontré conversaciones recientes y un audio de WhatsApp vinculado a este número.\n\nPara desbloquear el acceso completo al panel y escuchar el audio ahora, accede al enlace oficial:\n{checkoutUrl}"
      : (flowLanguage === 'en'
        ? "I found recent conversations and a WhatsApp audio linked to this number.\n\nTo unlock full access to the dashboard and listen to the audio now, access the official link:\n{checkoutUrl}"
        : "Localizei conversas recentes e um áudio do WhatsApp vinculado a este número.\n\nPara liberar o acesso completo ao painel e ouvir o áudio agora, acesse o link oficial:\n{checkoutUrl}");

    chatData.variables.checkoutUrl = funnel.upsellStages?.stage_49?.checkoutUrl || funnel.checkoutUrl || 'https://pay.kirvano.com/checkout-49';
    const offerTemplate = getNodeText('node-offer-checkout', fallbackOffer);
    const offerMsg = interpolateVars(offerTemplate);

    db.addChatMessage(phone, { from: 'bot', text: offerMsg, instanceId: inst.id }, 'OFERTA_ENVIADA');
    await sendOutgoingTextMessage(inst, phone, offerMsg);

    chatData.state = 'OFERTA_ENVIADA';
    chats[phone] = chatData;
    db.saveChats(chats);
    eventBus.emit('chat_updated', { phone });
    return { success: true, step: 'proof', state: 'OFERTA_ENVIADA' };
  } else if (step === 'checkout' || step === 'send_checkout') {
    // 2. DISPARO MANUAL DE LINK DE CHECKOUT
    const stageInfo = getCurrentStageInfo(chatData.upsellStage || 'stage_49', funnel, flowLanguage);
    const checkoutUrl = stageInfo.checkoutUrl || funnel.upsellStages?.stage_49?.checkoutUrl || funnel.checkoutUrl || 'https://pay.kirvano.com/checkout-49';
    chatData.variables.checkoutUrl = checkoutUrl;

    const checkoutMsg = flowLanguage === 'es'
      ? `Enlace seguro para desbloquear el informe completo (Valor: $ ${stageInfo.value}):\n👉 ${checkoutUrl}`
      : (flowLanguage === 'en'
        ? `Secure link to unlock the full report (Amount: $ ${stageInfo.value}):\n👉 ${checkoutUrl}`
        : `Link seguro para liberação do relatório completo (Valor: R$ ${stageInfo.value}):\n👉 ${checkoutUrl}`);

    db.addChatMessage(phone, { from: 'bot', text: checkoutMsg, instanceId: inst.id }, 'OFERTA_ENVIADA');
    await sendOutgoingTextMessage(inst, phone, checkoutMsg);

    chatData.state = 'OFERTA_ENVIADA';
    chats[phone] = chatData;
    db.saveChats(chats);
    eventBus.emit('chat_updated', { phone });
    return { success: true, step: 'checkout', state: 'OFERTA_ENVIADA' };
  } else {
    // 3. DISPARO INICIAL / BOAS-VINDAS DO FLUXO
    const fallbackWelcome = flowLanguage === 'es'
      ? "¡Hola! Guarda mi contacto y envíame el número de la persona que ya te mando la prueba."
      : (flowLanguage === 'en'
        ? "Hello! Save my contact and send the person's phone number and I'll send you the proof right away."
        : "Olá, Salve o meu contato e envie o número da pessoa que já vou mandar a prova");

    const welcomeTemplate = getNodeText('node-welcome', fallbackWelcome);
    const welcomeText = interpolateVars(welcomeTemplate);

    chatData.state = 'AGUARDANDO_NUMERO';
    chatData.upsellStage = 'stage_49';
    chats[phone] = chatData;
    db.saveChats(chats);

    db.addChatMessage(phone, { from: 'bot', text: welcomeText, instanceId: inst.id }, 'AGUARDANDO_NUMERO');
    await sendOutgoingTextMessage(inst, phone, welcomeText);
    eventBus.emit('chat_updated', { phone });
    return { success: true, step: 'start', message: welcomeText, state: 'AGUARDANDO_NUMERO' };
  }
}

module.exports = {
  processIncomingMessage,
  lookupProfilePicture,
  executeFlowGraph,
  executeTikTokPixelNode,
  triggerManualFlow,
  simulateTyping,
  getStageTag,
  extractNewTargetPhone,
  eventBus
};
