const axios = require('axios');
const db = require('../storage/db');
const cryptoService = require('./cryptoService');

/**
 * Obtém e descriptografa a API Key da OpenAI de forma segura
 */
function getOpenAiApiKey() {
  const settings = db.getSettings() || {};
  const rawKey = process.env.OPENAI_API_KEY || settings.openaiApiKey || '';
  if (!rawKey) return '';
  return cryptoService.decrypt(rawKey);
}

/**
 * Trata o primeiro contato do lead:
 * 1. Se for o padrão do anúncio ("Olá! Posso ter mais informações sobre isso?") ou saudações comuns:
 *    Retorna a mensagem de boas-vindas padrão: "Olá, Salve o meu contato e envie o número da pessoa que já vou mandar a prova"
 * 2. Se for um número de telefone direto:
 *    Retorna { type: 'PHONE', targetPhone: ... }
 * 3. Se contiver DÚVIDA ou OBJEÇÃO (ex: "como funciona", "é golpe", "quanto custa", "é seguro", etc.):
 *    A IA quebra a objeção com segurança e simpatia, e finaliza direcionando para o funil:
 *    pedindo para salvar o contato e enviar o número da pessoa com DDD para gerar a prova.
 */
async function handleInitialContact(userMessage, language = 'pt', defaultWelcomeText = "Olá, Salve o meu contato e envie o número da pessoa que já vou mandar a prova") {
  const cleanMsg = (userMessage || '').trim();
  const rawDigits = cleanMsg.replace(/\D/g, '');
  if (rawDigits.length >= 8 && rawDigits.length <= 15) {
    return { type: 'PHONE', targetPhone: rawDigits };
  }

  const lower = cleanMsg.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Mensagens padrão de anúncio ou saudações simples
  const isStandardGreeting = (
    lower === 'ola! posso ter mais informacoes sobre isso?' ||
    lower === 'ola posso ter mais informacoes sobre isso' ||
    lower === 'posso ter mais informacoes sobre isso?' ||
    lower === 'posso ter mais informacoes sobre isso' ||
    lower === 'posso ter mais informacoes' ||
    lower === 'quero mais informacoes' ||
    lower === 'quero saber mais' ||
    lower === 'informacoes' ||
    lower === 'ola' || lower === 'olá' || lower === 'oi' || lower === 'oie' ||
    lower === 'bom dia' || lower === 'boa tarde' || lower === 'boa noite' ||
    lower === 'opa' || lower === 'salve' || lower === 'alo' || lower === 'alô' ||
    lower.length <= 4
  );

  if (isStandardGreeting) {
    return {
      type: 'STANDARD',
      reply: defaultWelcomeText
    };
  }

  // Verifica se o lead enviou dúvida ou objeção
  const isObjectionOrDoubt = (
    lower.includes('como funciona') || lower.includes('o que e') || lower.includes('quem e') ||
    lower.includes('seguro') || lower.includes('confiavel') || lower.includes('como assim') ||
    lower.includes('que prova') || lower.includes('como voce') || lower.includes('quem e voce') ||
    lower.includes('como acha') || lower.includes('explica') || lower.includes('funciona mesmo') ||
    lower.includes('da certo') || lower.includes('golpe') || lower.includes('fraude') ||
    lower.includes('quanto custa') || lower.includes('preco') || lower.includes('preço') ||
    lower.includes('valor') || lower.includes('paga') || lower.includes('pagar') ||
    lower.includes('e gratis') || lower.includes('e gratuito') || lower.includes('descobre') ||
    lower.includes('saber') || lower.includes('fake') || lower.includes('mentira') ||
    lower.includes('hack') || lower.includes('clonar') || lower.includes('espiao') ||
    lower.includes('duvida') || lower.includes('ajuda') || lower.includes('como faco') ||
    lower.includes('?')
  );

  const settings = db.getSettings();
  const apiKey = getOpenAiApiKey();

  if (apiKey && isObjectionOrDoubt) {
    try {
      const prompt = `Você é a atendente oficial brasileira de suporte e consultoria do sistema de verificação sigilosa de conversas do WhatsApp.
O cliente acabou de mandar a primeira mensagem no WhatsApp com uma dúvida ou objeção antes de iniciar o funil:
"${cleanMsg}"

SUAS REGRAS DE RESPOSTA:
1. Responda à dúvida ou quebre a objeção com simpatia, acolhimento e tom humanizado brasileiro (1 a 2 parágrafos curtos).
2. Explique que o rastreio é 100% sigiloso (a pessoa investigada NUNCA fica sabendo) e que o teste inicial com a prova/foto serve exatamente para demonstrar na prática que os dados existem.
3. Se perguntar sobre valores: explique que a busca inicial e a prova são para demonstrar a existência dos dados, e caso ele queira liberar todo o relatório completo e áudios a taxa única é acessível (R$ 49,90).
4. CONEXÃO DIRETA COM O FUNIL (OBRIGATÓRIO): Termine a mensagem convidando o cliente a iniciar o funil: peça gentilmente para ele salvar o seu contato e enviar o número da pessoa com DDD para você já mandar a prova na hora.
5. Tom natural de WhatsApp, emojis leves (😊, 🔒, 👍). Nunca diga que é robô ou IA.`;

      const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: settings.openaiModel || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: cleanMsg }
          ],
          max_tokens: 180,
          temperature: 0.7
        },
        { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 6000 }
      );

      const aiReply = res.data?.choices?.[0]?.message?.content?.trim();
      if (aiReply) {
        return { type: 'OBJECTION_BREAK', reply: aiReply };
      }
    } catch (e) {
      console.warn('[handleInitialContact] Erro ao chamar OpenAI, usando fallback:', e.message);
    }
  }

  if (isObjectionOrDoubt) {
    return {
      type: 'OBJECTION_BREAK',
      reply: "Nosso sistema faz uma verificação 100% sigilosa nos registros e áudios através do número de telefone, e a pessoa investigada nunca fica sabendo. 😊🔒\n\nA busca inicial é rápida para você ver na prática a prova de que as conversas foram localizadas.\n\nPara começarmos, salva o meu contato aqui e me envie o número da pessoa com DDD que já vou mandar a prova para você!"
    };
  }

  // Qualquer outra mensagem genérica que não tenha número nem dúvida explícita:
  return {
    type: 'STANDARD',
    reply: defaultWelcomeText
  };
}

/**
 * Classifica a resposta do lead logo após a mensagem de Boas-Vindas ou enquanto aguarda o número
 */
async function classifyWelcomeReply(userMessage, language = 'pt') {
  const settings = db.getSettings();
  const apiKey = getOpenAiApiKey();
  const funnel = db.getFunnel();
  const lang = (language || 'pt').toLowerCase();

  const welcomeTexts = {
    pt: {
      doubt: "Nosso sistema localiza mensagens, áudios apagados e registros nos servidores pelo número de telefone. É 100% sigiloso e a pessoa não fica sabendo.\n\nPara eu gerar a prévia e te mandar a prova, só me envie o número dela com DDD aqui.",
      reinforce: funnel.reinforceNumberMessage || "Assim que enviar o número já ativo aqui 👍\n\nPreciso do WhatsApp da pessoa:\nDDD+9+número (ex: 11912345678)\n\nManda rápido."
    },
    es: {
      doubt: "Nuestro sistema localiza mensajes, audios eliminados y registros en los servidores mediante el número de teléfono. Es 100% confidencial y la persona no se entera.\n\nPara que pueda generar la vista previa y enviarte la prueba, solo envíame su número aquí con el código de país.",
      reinforce: "En cuanto envíes el número ya lo activo aquí 👍\n\nNecesito el WhatsApp de la persona:\nCódigo de país + número\n\nEnvíalo rápido."
    },
    en: {
      doubt: "Our system locates messages, deleted audios, and server records using the phone number. It is 100% confidential and the person will never know.\n\nTo generate the preview and send you the proof, just send me their number with country code here.",
      reinforce: "As soon as you send the number I'll activate it right here 👍\n\nI need the person's WhatsApp number:\nCountry code + number\n\nSend it quickly."
    }
  };

  const selectedTexts = welcomeTexts[lang] || welcomeTexts.pt;
  const doubtReply = selectedTexts.doubt;
  const reinforceReply = selectedTexts.reinforce;

  const rawDigits = (userMessage || '').replace(/\D/g, '');
  if (rawDigits.length >= 8 && rawDigits.length <= 15) {
    return { type: 'PHONE', targetPhone: rawDigits };
  }

  const lower = (userMessage || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Detecta se é dúvida sobre como funciona o serviço em PT, ES ou EN
  const isDoubt = (
    // Português
    lower.includes('como funciona') || lower.includes('o que e') || lower.includes('quem e') ||
    lower.includes('e seguro') || lower.includes('e confiavel') || lower.includes('como assim') ||
    lower.includes('que prova') || lower.includes('como voce') || lower.includes('quem e voce') ||
    lower.includes('como acha') || lower.includes('explica') || lower.includes('me explica') ||
    lower.includes('funciona mesmo') || lower.includes('da certo') || lower.includes('golpe') ||
    lower.includes('quanto custa') || lower.includes('valor') || lower.includes('paga') ||
    lower.includes('preco') || lower.includes('preço') || lower.includes('descobre') ||
    lower.includes('fake') || lower.includes('mentira') || lower.includes('?')
  );

  // Se OpenAI estiver configurada, gera resposta precisa e persuasiva
  if (apiKey && isDoubt) {
    try {
      const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: settings.openaiModel || 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `Você é a atendente de suporte oficial e consultora do sistema de verificação sigilosa de conversas.
O cliente já recebeu o convite inicial para enviar o número mas tem a seguinte dúvida ou objeção:
"${userMessage}"
Tire a dúvida com simpatia e segurança em 1 a 2 parágrafos curtos, garanta sigilo total e finalize pedindo para ele enviar o número da pessoa com DDD para você puxar a prova.`
            },
            { role: 'user', content: userMessage }
          ],
          max_tokens: 150,
          temperature: 0.7
        },
        { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 5000 }
      );
      const aiReply = res.data?.choices?.[0]?.message?.content?.trim();
      if (aiReply) return { type: 'DOUBT', reply: aiReply };
    } catch (e) {}
  }

  if (isDoubt) {
    return { type: 'DOUBT', reply: doubtReply };
  }

  // Padrão: resposta aleatória / confirmação sem número
  return { type: 'RANDOM', reply: reinforceReply };
}

/**
 * Classifica a mensagem do lead em qualquer etapa do funil/upsell e retorna a resposta oficial exata
 */
async function classifyAndReply(userMessage, conversationHistory = [], currentStageInfo = {}, language = 'pt') {
  const funnel = db.getFunnel();
  const settings = db.getSettings();
  const apiKey = getOpenAiApiKey();
  const lang = (language || 'pt').toLowerCase();

  const currentValue = currentStageInfo.value || (lang === 'pt' ? '49,90' : '49.90');
  let paidValue = currentStageInfo.paidValue;
  if (!paidValue) {
    if (currentValue === '49,90' || currentValue === '49.90') paidValue = '0';
    else if (currentValue === '100') paidValue = (lang === 'pt' ? '49,90' : '49.90');
    else if (currentValue === '200') paidValue = '100';
    else if (currentValue === '400') paidValue = '200';
    else paidValue = '0';
  }
  const nextValue = currentStageInfo.nextValue || '100';
  const checkoutUrl = currentStageInfo.checkoutUrl || funnel.checkoutUrl || 'https://pay.kirvano.com/checkout-49';

  const formatText = (template) => {
    if (!template) return '';
    return template
      .replace(/\{paidValue\}/gi, paidValue)
      .replace(/\{currentValue\}/gi, currentValue)
      .replace(/\{nextValue\}/gi, nextValue)
      .replace(/\{checkoutUrl\}/gi, checkoutUrl)
      .replace(/\{link_pagamento\}/gi, checkoutUrl);
  };

  const objectionDictionaries = {
    pt: {
      already_paid_refuses_new: currentValue === '49,90'
        ? "Para liberar a busca inicial e o painel das conversas no sistema, é necessário concluir a ativação de R$ 49,90.\n\nQuer que eu te reenvie o link para finalizar?"
        : "O pagamento anterior de R$ {paidValue} liberou a etapa, mas para garantir o acesso completo ao sistema precisamos avançar com a etapa de R$ {currentValue}. Assim que concluir o pagamento atual pelo link que te enviei, você terá tudo liberado para acompanhar.\n\nQuer que eu reenvie o link do pagamento de R$ {currentValue} para você?",
      why_pay: "Cada etapa ativa ferramentas essenciais para liberar o acesso completo no sistema. Sem concluir o pagamento da etapa atual de R$ {currentValue} pelo link que te enviei, o painel não fica 100% liberado. Consegue finalizar pelo link e me enviar o comprovante?",
      refuse_or_random: "Tranquilo, qualquer coisa é só chamar 🙂\n\nSe quiser, pode seguir com o pagamento pelo link que já te enviaram e me enviar o comprovante aqui. Estou pronta para ajudar a Descobrir tudo!",
      denounce_or_scam: "Entendo sua decisão. Se quiser, posso te ajudar a usar melhor o sistema para aproveitar tudo que ele oferece.\n\nEnquanto isso, se mudar de ideia, é só finalizar a etapa atual de R$ {currentValue} pelo link e me enviar o comprovante para liberar seu acesso completo. Estou aqui para ajudar no que precisar.",
      what_is_tax: "O valor de R$ {currentValue} é referente à etapa necessária para liberar esse recurso do sistema.\n\nQuando você concluir o pagamento pelo link que te enviei, libera tudo para acompanhar direitinho.\n\nQuer que eu te envie o link de R$ {currentValue} para seguir agora?",
      when_get_photo_or_access: "Você já tem acesso inicial liberado pela etapa que pagou, mas o sistema libera funcionalidades completas conforme avançam as etapas.\n\nAssim que fizer o pagamento da etapa de R$ {currentValue} e me enviar o comprovante, você terá o acesso completo para acompanhar tudo no painel.\n\nQuer que eu mande o link da etapa de R$ {currentValue} para você finalizar?",
      send_link: "Segue o link para você concluir o pagamento da etapa de R$ {currentValue}:\n{checkoutUrl}\n\nAssim que finalizar, só me mandar o comprovante por aqui!",
      said_paid_no_image: "Pode me enviar o comprovante do pagamento de R$ {currentValue} por favor? Assim já verifico e te libero o próximo passo.",
      no_receipt_image: "Não recebi nenhum comprovante na imagem que você enviou. Pode mandar uma foto ou print nítido do comprovante de pagamento do valor de R$ {currentValue}? Assim consigo verificar certinho para liberar o próximo passo.",
      unclear_or_cropped: "O pagamento não está totalmente visível para confirmar se foi concluído pelo sistema.\n\nPode enviar um print ou foto mais completa da tela de detalhes da transação, mostrando o status de pagamento aprovado? Assim consigo liberar o próximo passo para você.",
      try_another_number: "Sim, com certeza você pode testar outro número! 😊 É só me enviar o novo número com DDD aqui que o sistema já faz a busca inicial e te envio a prévia agora mesmo."
    },
    es: {
      already_paid_refuses_new: currentValue === '49.90'
        ? "Para desbloquear la búsqueda inicial y el panel de conversaciones en el sistema, es necesario completar la activación de $ 49.90.\n\n¿Quieres que te reenvíe el enlace para finalizar?"
        : "El pago anterior de $ {paidValue} desbloqueó la etapa, pero para garantizar el acceso completo al sistema necesitamos avanzar con la etapa de $ {currentValue}. En cuanto completes el pago actual mediante el enlace que te envié, tendrás todo desbloqueado para revisarlo.\n\n¿Quieres que te reenvíe el enlace de pago de $ {currentValue}?",
      why_pay: "Cada etapa activa herramientas esenciales para desbloquear el acceso completo en el sistema. Sin completar el pago de la etapa actual de $ {currentValue} mediante el enlace que te envié, el panel no queda 100% habilitado. ¿Puedes finalizar por el enlace y enviarme el comprobante?",
      refuse_or_random: "Tranquilo, cualquier cosa aquí estoy 🙂\n\nSi deseas, puedes continuar con el pago por el enlace enviado y mandarme el comprobante aquí. ¡Estoy lista para ayudarte a descubrir todo!",
      denounce_or_scam: "Entiendo tu postura. Si lo deseas, puedo ayudarte a aprovechar al máximo todas las funciones que ofrece el sistema.\n\nMientras tanto, si cambias de opinión, solo finaliza la etapa actual de $ {currentValue} mediante el enlace y envíame el comprobante para habilitar tu acceso total. Estoy aquí para lo que necesites.",
      what_is_tax: "El monto de $ {currentValue} corresponde a la etapa necesaria para desbloquear esta función del sistema.\n\nEn cuanto concluyas el pago por el enlace que te envié, se libera todo para que lo revises con calma.\n\n¿Quieres que te envíe el enlace de $ {currentValue} para continuar ahora?",
      when_get_photo_or_access: "Ya tienes acceso inicial por la etapa que pagaste, pero el sistema va habilitando funciones completas a medida que avanzan las etapas.\n\nEn cuanto hagas el pago de la etapa de $ {currentValue} y me envíes el comprobante, tendrás el acceso completo para ver todo en el panel.\n\n¿Quieres que te mande el enlace de la etapa de $ {currentValue} para finalizar?",
      send_link: "Aquí tienes el enlace para completar el pago de la etapa de $ {currentValue}:\n{checkoutUrl}\n\n¡En cuanto finalices, solo envíame el comprobante por aquí!",
      said_paid_no_image: "¿Podrías enviarme el comprobante del pago de $ {currentValue} por favor? Así lo verifico de inmediato y te habilito el siguiente paso.",
      no_receipt_image: "No recibí ningún comprobante en la imagen que enviaste. ¿Podrías mandar una foto o captura clara del comprobante de pago por $ {currentValue}? Así puedo verificarlo para habilitar el siguiente paso.",
      unclear_or_cropped: "El pago no está completamente visible para confirmar si fue aprobado por el sistema.\n\n¿Podrías enviar una captura más completa donde se vea el estado de pago aprobado? Así podré habilitar el siguiente paso para ti.",
      try_another_number: "¡Sí, puedes probar con otro número sin ningún problema! 😊 Solo envíame el nuevo número con código de país aquí y de inmediato inicio la búsqueda para enviarte la previa."
    },
    en: {
      already_paid_refuses_new: currentValue === '49.90'
        ? "To unlock the initial search and chat panel in the system, it is necessary to complete the $ 49.90 activation.\n\nWould you like me to resend the link to finalize?"
        : "The previous payment of $ {paidValue} unlocked the stage, but to ensure full access to the system we need to proceed with the $ {currentValue} stage. As soon as you complete the current payment using the link sent, you will have everything unlocked to track.\n\nWould you like me to resend the payment link for $ {currentValue}?",
      why_pay: "Each stage activates essential tools to release full access to the system. Without completing the payment for the current stage of $ {currentValue} via the link sent, the dashboard is not 100% active. Can you finalize through the link and send me the receipt?",
      refuse_or_random: "No problem, feel free to reach out anytime 🙂\n\nIf you want, you can proceed with the payment via the link provided and send the receipt here. I'm ready to help you uncover everything!",
      denounce_or_scam: "I understand your perspective. If you want, I can guide you through the system to help you take advantage of everything it provides.\n\nIn the meantime, if you change your mind, simply complete the current $ {currentValue} stage via the link and send me the receipt to unlock your full access. I'm here to help with whatever you need.",
      what_is_tax: "The amount of $ {currentValue} refers to the required stage to unlock this system feature.\n\nOnce you complete the payment via the link provided, everything unlocks for you to review properly.\n\nWould you like me to send you the link for $ {currentValue} to continue now?",
      when_get_photo_or_access: "You already have initial access unlocked from the stage you paid, but the system releases full features as each stage completes.\n\nAs soon as you make the payment for the $ {currentValue} stage and send me the receipt, you will have full access to see everything in the dashboard.\n\nWould you like me to send the link for the $ {currentValue} stage to finalize?",
      send_link: "Here is the link for you to complete the payment for the $ {currentValue} stage:\n{checkoutUrl}\n\nAs soon as you finish, just send me the receipt right here!",
      said_paid_no_image: "Could you please send me the receipt for the $ {currentValue} payment? That way I can verify it immediately and unlock the next step for you.",
      no_receipt_image: "I didn't receive any receipt in the image you sent. Could you send a clear photo or screenshot of the payment receipt for $ {currentValue}? That way I can verify it and unlock the next step.",
      unclear_or_cropped: "The payment details are not fully visible to confirm system approval.\n\nCould you send a complete screenshot showing the approved payment status? That way I can unlock the next step for you.",
      try_another_number: "Yes, you can definitely test another number! 😊 Just send me the new number with country code here and I'll immediately start the search and send you the preview."
    }
  };

  const langDict = objectionDictionaries[lang] || objectionDictionaries.pt;
  const objectionTexts = {};
  for (const key of Object.keys(langDict)) {
    objectionTexts[key] = formatText(langDict[key]);
  }

  // 1. Se houver API key da OpenAI configurada, gera resposta humana, conversacional e persuasiva
  if (apiKey) {
    try {
      const recentHistory = (conversationHistory || []).slice(-6).map(m => ({
        role: (m.from === 'agent' || m.from === 'bot') ? 'assistant' : 'user',
        content: m.text || (m.mediaUrl ? '[Imagem enviada]' : '')
      })).filter(m => m.content && m.content !== '[Imagem enviada]');

      let systemPrompt = settings.openaiSystemPrompt || '';
      if (!systemPrompt || systemPrompt.length < 50) {
        systemPrompt = `Você é a atendente de suporte oficial e consultora do sistema de verificação sigilosa de conversas.
Seu objetivo é ser extremamente humana, acolhedora, prestativa e brasileira no tom, tirando dúvidas do cliente e direcionando-o com segurança a concluir o pagamento de R$ ${currentValue} pelo link oficial para liberar o relatório completo.

Contexto do cliente:
- O cliente já enviou o número da pessoa que ele deseja investigar.
- O sistema já fez o rastreio inicial e enviou a prévia/prova com a foto de perfil da pessoa, mapa e áudio gravado.
- Os arquivos completos (áudios descriptografados, fotos apagadas, mensagens de WhatsApp e localização em tempo real) já estão processados e prontos no servidor, apenas aguardando a liberação do acesso.
- Link de pagamento: ${checkoutUrl}
- Valor atual: R$ ${currentValue}

Regras:
1. NUNCA diga que é IA ou robô. Você é uma atendente real tirando dúvidas pelo WhatsApp.
2. Responda diretamente ao que o cliente perguntou de forma natural, acolhedora e confiante.
3. Se perguntar 'Por que tenho que pagar?': Explique que a prévia foi gratuita para comprovar a existência das conversas, e a taxa de R$ ${currentValue} cobre os servidores de descriptografia em tempo real e sigilo total (a pessoa nunca sabe).
4. Se disser que vai pagar ("vou pagar", "ok", "beleza"): Agradeça e instrua: "Perfeito! Fico no seu aguardo. Assim que concluir o pagamento pelo link oficial, me envia o comprovante aqui no chat que eu já ativo a sua liberação completa na hora! 🔒".
5. Se pedir o link ou dados: Reenvie o link oficial ${checkoutUrl}.
6. Se disser que já pagou: Peça para enviar o comprovante por aqui.
7. Se perguntar se pode testar ou investigar outro número ("posso tentar outro número?", "consigo ver outro?", "posso ver outra pessoa?"): Diga com entusiasmo e simpatia que sim, com certeza! É só me passar o novo número com DDD aqui que eu já inicio a busca no sistema e te trago a prévia imediatamente!
8. Mantenha respostas curtas e ágeis (1 a 3 parágrafos curtos), exatamente como no WhatsApp real.`;
      } else {
        systemPrompt = systemPrompt
          .replace(/\{checkoutUrl\}/gi, checkoutUrl)
          .replace(/\{currentValue\}/gi, currentValue);
      }

      const messages = [
        { role: 'system', content: systemPrompt },
        ...recentHistory,
        { role: 'user', content: userMessage }
      ];

      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: settings.openaiModel || 'gpt-4o-mini',
          messages,
          max_tokens: 220,
          temperature: 0.5
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 8000
        }
      );

      const reply = response.data.choices[0]?.message?.content?.trim();
      if (reply) {
        console.log(`[AI Generator (OpenAI)] "${userMessage}" -> "${reply.slice(0, 80)}..."`);
        return reply;
      }
    } catch (err) {
      console.warn('[AI Generator Error] Falha na geração OpenAI, usando classificador local:', err.response?.data || err.message);
    }
  }

  // 2. Fallback: Classificador local de regras predefinidas
  const classification = localClassifier(userMessage, currentStageInfo, lang);

  // Mapeamento direto para as respostas oficiais do script
  if (classification.includes('WHY_PAY')) return objectionTexts.why_pay;
  if (classification.includes('ALREADY_PAID_REFUSES_NEW')) return objectionTexts.already_paid_refuses_new;
  if (classification.includes('DENOUNCE_OR_SCAM')) return objectionTexts.denounce_or_scam;
  if (classification.includes('WHAT_IS_TAX')) return objectionTexts.what_is_tax;
  if (classification.includes('WHEN_GET_PHOTO_OR_ACCESS')) return objectionTexts.when_get_photo_or_access;
  if (classification.includes('SEND_LINK')) return objectionTexts.send_link;
  if (classification.includes('SAID_PAID')) return objectionTexts.said_paid_no_image;
  if (classification.includes('TRY_ANOTHER_NUMBER')) return objectionTexts.try_another_number;

  return objectionTexts.refuse_or_random;
}

/**
 * Classificador local semântico e fonético para fallback ultra-resiliente
 */
function localClassifier(text, currentStageInfo = {}, language = 'pt') {
  const lower = (text || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // 1. Falou de denúncia, golpe, polícia, reembolso (PT / ES / EN)
  if (
    lower.includes('golpe') || lower.includes('denuncia') || lower.includes('policia') ||
    lower.includes('reembolso') || lower.includes('estorno') || lower.includes('procon') ||
    lower.includes('ladrao') || lower.includes('crime') || lower.includes('process') ||
    lower.includes('advogado') || lower.includes('delegacia') || lower.includes('picareta') ||
    lower.includes('fraude') || lower.includes('estelionato') ||
    lower.includes('estafa') || lower.includes('estafador') || lower.includes('denunciar') ||
    lower.includes('abogado') || lower.includes('scam') || lower.includes('fraud') ||
    lower.includes('police') || lower.includes('lawyer') || lower.includes('refund')
  ) {
    return 'DENOUNCE_OR_SCAM';
  }

  // 2. Reclamação de já ter pago o anterior e questionar/recusar o novo
  if (
    (lower.includes('ja paguei') || lower.includes('paguei o') || lower.includes('ja pague') || lower.includes('ja fiz o') || lower.includes('paguei') || lower.includes('ya pague') || lower.includes('ya abone') || lower.includes('already paid') || lower.includes('i paid') || lower.includes('paid already')) &&
    (lower.includes('novo') || lower.includes('100') || lower.includes('200') || lower.includes('400') || lower.includes('49') || lower.includes('outro') || lower.includes('esse') || lower.includes('denovo') || lower.includes('de novo') || lower.includes('mais') || lower.includes('novamente') || lower.includes('otra') || lower.includes('otro') || lower.includes('new') || lower.includes('again') || lower.includes('more'))
  ) {
    return 'ALREADY_PAID_REFUSES_NEW';
  }

  // 3. Pediu o link ou pagamento
  if (
    (lower.includes('link') || lower.includes('pix') || lower.includes('pagar') || lower.includes('enlace') || lower.includes('pay') || lower.includes('checkout')) &&
    (lower.includes('manda') || lower.includes('envia') || lower.includes('cade') || lower.includes('qual') || lower.includes('passa') || lower.includes('onde') || lower.includes('donde') || lower.includes('send') || lower.includes('where'))
  ) {
    return 'SEND_LINK';
  }

  // 4. Afirmou que pagou
  if (
    lower.includes('ja paguei') || lower.includes('ta pago') || lower.includes('paguei') ||
    lower.includes('mandei o pix') || lower.includes('fiz o pix') || lower.includes('transferi') ||
    lower.includes('acabei de pagar') || lower.includes('ja fiz') || lower.includes('pix feito') ||
    lower.includes('ya pague') || lower.includes('ya transferi') || lower.includes('listo el pago') ||
    lower.includes('i already paid') || lower.includes('paid it') || lower.includes('just paid')
  ) {
    return 'SAID_PAID';
  }

  // 5. Pergunta por que tem que pagar
  if (
    (lower.includes('por que') || lower.includes('pq') || lower.includes('porque') || lower.includes('motivo') || lower.includes('pra que') || lower.includes('por que') || lower.includes('why')) &&
    (lower.includes('pagar') || lower.includes('pago') || lower.includes('cobra') || lower.includes('gratis') || lower.includes('valor') || lower.includes('preco') || lower.includes('custo') || lower.includes('dinheiro') || lower.includes('cobran') || lower.includes('pay') || lower.includes('charge') || lower.includes('fee'))
  ) {
    return 'WHY_PAY';
  }

  // 6. Pergunta do que se trata a taxa atual
  if (
    lower.includes('taxa de 100') || lower.includes('taxa de cem') || lower.includes('taxa de 200') || lower.includes('taxa de 400') || lower.includes('taxa de 49') ||
    lower.includes('que taxa') || lower.includes('do que se trata essa taxa') || lower.includes('pra que essa taxa') || lower.includes('essa taxa') ||
    lower.includes('tarifa de 100') || lower.includes('tarifa de 200') || lower.includes('tarifa de 400') || lower.includes('que tarifa') ||
    lower.includes('what fee') || lower.includes('fee of 100') || lower.includes('fee of 200') || lower.includes('fee of 400')
  ) {
    return 'WHAT_IS_TAX';
  }

  // 7. Pergunta sobre acesso, quando vai ver tudo ou receber a foto
  if (
    (lower.includes('quando') || lower.includes('cade') || lower.includes('como faco') || lower.includes('cuando') || lower.includes('when') || lower.includes('where')) &&
    (lower.includes('recebo') || lower.includes('foto') || lower.includes('acesso') || lower.includes('ver tudo') || lower.includes('mensagens') || lower.includes('painel') || lower.includes('libera') || lower.includes('conversas') || lower.includes('recibo') || lower.includes('ver todo') || lower.includes('access') || lower.includes('messages'))
  ) {
    return 'WHEN_GET_PHOTO_OR_ACCESS';
  }

  // 8. Pergunta se pode testar outro número
  if (
    lower.includes('outro numero') || lower.includes('outro contato') || lower.includes('outra pessoa') ||
    lower.includes('trocar numero') || lower.includes('mudar numero') || lower.includes('testar outro') ||
    lower.includes('tentar outro') || lower.includes('ver outro') || lower.includes('outro zap') ||
    lower.includes('otro numero') || lower.includes('otra persona') || lower.includes('another number') ||
    lower.includes('other number')
  ) {
    return 'TRY_ANOTHER_NUMBER';
  }

  return 'REFUSE_OR_RANDOM';
}

module.exports = {
  classifyAndReply,
  classifyWelcomeReply,
  handleInitialContact,
  localClassifier
};
