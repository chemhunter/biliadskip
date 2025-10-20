// api/analyze.js
// ----------- 工具函数 -----------
function extractTimestamp(text) {
  const match = text.match(/(\d{1,2}:\d{2}(?::\d{2})?)[^\d]+(\d{1,2}:\d{2}(?::\d{2})?)/);
  return match ? { start: match[1], end: match[2] } : null;
}

function decodeBV(bv) {
  const table = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF';
  const tr = {};
  for (let i = 0; i < table.length; i++) tr[table[i]] = i;
  const s = [11, 10, 3, 8, 4, 6];
  const xor = 177451812;
  const add = 8728348608;

  if (!bv || bv.length !== 12 || !bv.startsWith('BV')) return null;
  let r = 0;
  for (let i = 0; i < 6; i++) {
    const c = bv[s[i]];
    if (!(c in tr)) return null;
    r += tr[c] * 58 ** i;
  }
  return (r - add) ^ xor;
}

// ----------- Supabase 操作函数 -----------
async function preflightCheckWithSupabase(bvNumber) {
    // 从 Vercel 的环境变量中获取 URL 和 anon key
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    const functionUrl = 'https://akoaopeqigjwpcksqdyf.supabase.co/functions/v1/bv_calls'; // 这是您新创建的 Supabase 函数
    const response = await fetch(functionUrl, {
        method: 'POST',
        headers: {
            'apikey': supabaseAnonKey,
            'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ bv: bvNumber }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`Supabase preflight check failed with status ${response.status}:`, errorText);
        throw new Error('Supabase preflight check failed.');
    }

    return await response.json(); // 返回 { allowed, reason }
}

/* 移除该逻辑
async function uploadAdTimestamp({ bv, timestamp_range, source, user_id, up_id }) {
    const url = "https://akoaopeqigjwpcksqdyf.supabase.co/functions/v1/biliadskip";
    const headers = {'Content-Type': 'application/json'};
    const body = {bv, timestamp_range, source, user_id, up_id};
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body)
        });

        if (!resp.ok) {
            const errorText = await resp.text();
            console.error(`❌ 调用Supabase Edge Function失败! 状态码: ${resp.status}, 响应: ${errorText}`);
            return false;
        }
        const resultJson = await resp.json();
        console.log('✅ 成功通过Edge Function上传时间戳:', resultJson);
        return true;

    } catch (err) {
        console.error("❌ 调用Supabase Edge Function时发生网络异常:", err);
        return false;
    }
}
*/
let aiModelName
// ----------- 调用AI -----------
async function fetchAITimestamps(subtitlesText, commentText ='') {
  const system_prompt = `
   你是一个精准的广告分析引擎。
   你的唯一任务是分析用户提供的视频字幕和评论区文本，判断其中是否包含商业广告，并返回一个结构化的JSON对象。

   该JSON对象必须包含以下字段:
     - "start"和"end": 广告的起始和结束时间戳 (格式 "mm:ss")。
     - "noAd": 一个布尔值，如果确定无广告则为 true。
     - "product": 字符串，广告中推广的商品名称。
   若经分析未发现广告，返回 {"start": null, "end": null, "product": null, "noAd": true} 。

   判断规则：
    1. 你的回复【必须】是一个合法的、可以被JSON.parse()解析的JSON对象。
    2. 不要回复任何JSON对象之外的额外文字、解释或注释。
    3. 将字幕中明显开始偏离主题，试图平滑导入广告的部分也按广告处理，典型引入语：“说到...那就不得不提...”、“不仅...我们日常也要...”。
    4. 商业广告一般不低于30s，不会涉及军用装备以及中国法律禁止公开出售的物品。
    5. 取最后一条广告字幕的时间戳与接下来的一条正常字幕的时间戳，将两者取平均值（向下取整）作为"end"时间戳。
`
  const user_prompt = `
    分析以下视频字幕内容：\n
    ${subtitlesText}\n
    以下是可能包含线索的评论区文本，供你参考：
    ${commentText}`
  
  // --- 1. 核心修改：配置源的动态决策 ---
  const AI_CONFIG = {
    apiUrl: null,
    apiKey: null,
    model: null,
    providerName: 'Kimi'
  }
  const aliyunConfigString = process.env.ALIYUN;

  if (aliyunConfigString) {
      console.log('检测到 ALIYUN 环境变量，优先使用...');
      try {
          const aliyunConfig = JSON.parse(aliyunConfigString);
          if (aliyunConfig.apiUrl && aliyunConfig.apikey && Array.isArray(aliyunConfig.model) && aliyunConfig.model.length > 0) {
              AI_CONFIG.apiUrl = aliyunConfig.apiUrl;
              AI_CONFIG.apiKey = aliyunConfig.apikey;
              
              const randomIndex = Math.floor(Math.random() * aliyunConfig.model.length);
              AI_CONFIG.model = aliyunConfig.model[randomIndex];
              
              AI_CONFIG.providerName = `Aliyun (${AI_CONFIG.model})`; // 更新提供商名称用于日志
              console.log(`✅ 已从阿里云配置中加载，随机选择模型: ${AI_CONFIG.model}`);
          } else {
              throw new Error("ALIYUN 配置格式不完整（缺少apiUrl, apikey或model数组）。");
          }
      } catch (e) {
          console.error("❌ 解析ALIYUN环境变量失败！将回退到默认配置。", e);
          AI_CONFIG.apiUrl = null; 
      }
  }

  if (!AI_CONFIG.apiUrl) {
      console.log('...回退到使用默认的KIMI 配置');
      const kimiConfig = JSON.parse(process.env.KIMI);
      AI_CONFIG.apiUrl = kimiConfig.apiUrl;
      AI_CONFIG.apiKey = kimiConfig.apikey;
      AI_CONFIG.model = 'moonshot-v1-8k';
  }
  
  aiModelName = AI_CONFIG.model;
  
  if (!AI_CONFIG.apiUrl || !AI_CONFIG.apiKey) {
      throw new Error("AI配置无效：未能从任何来源获取到有效的apiUrl和apiKey。");
  }

  const reqBody = {
    model: AI_CONFIG.model,
    messages: [
        { role: 'system', content: system_prompt },
        { role: 'user', content: user_prompt },
    ],
    temperature: 0.2,
    enable_thinking: false,
    max_tokens: 200,
  };

  const resp = await fetch(AI_CONFIG.apiUrl, {
    method: 'POST',
    headers: {
      //'apikey': AI_CONFIG.apiKey,
      'Authorization': `Bearer ${AI_CONFIG.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(reqBody),
  });

  // --- 核心修改：增加详细的失败日志记录 ---
  if (!resp.ok) {
      let errorBody = '';
      try {
          errorBody = await resp.text();
      } catch (e) {
          errorBody = '无法读取响应体。';
      }
      const errorMessage = `AI [${AI_CONFIG.providerName}] 请求失败! 
          请求目标URL: ${AI_CONFIG.apiUrl}
          状态码 (Status Code): ${resp.status} ${resp.statusText}
          响应体 (Response Body): ${errorBody}
      `;
      throw new Error(errorMessage);
  }

  const data = await resp.json();
  const aiRespText = data.choices?.[0]?.message?.content;
  if (!aiRespText) {
    throw new Error("AI未返回有效内容。");
    return { status: 500, json: { error: 'AI服务未返回任何内容' } };
  }

  try {
      // 智能提取被 ```json ... ``` 包裹的内容
      const jsonMatch = aiRespText.match(/```json\n([\s\S]*?)\n```|({[\s\S]*})/);
      if (!jsonMatch) throw new Error("AI回复中未找到有效的JSON代码块");
      result = JSON.parse(jsonMatch[1] || jsonMatch[2]);
      return {
        ...result,
        source: AI_CONFIG.model
      };
    } catch (e) {
      console.error("❌ JSON解析失败!", "原始回复:", aiRespText, "错误:", e);
      return { status: 500, json: { error: 'AI返回的不是有效的JSON', raw: aiRespText } };
  }
}

// ----------- 业务主流程 -----------
async function processRequest({bv, subtitles, user_id, up_id, ip, commentText}) {
  if (!bv || !Array.isArray(subtitles) || subtitles.length === 0) {
    return { status: 400, json: { error: '缺少必要字段' } };
  }
  const avNumber = decodeBV(bv);
  if (avNumber === null) {
    return { status: 400, json: { error: 'BV号无效' } };
  }

  const { allowed, reason } = await preflightCheckWithSupabase(bv);
  if (!allowed) {
      console.log(`BV ${bv} 的请求被预检拒绝: ${reason}`);
      return { status: 429, json: { success: false, aiResult: null, error: reason || '请求被拒绝' } };
  }
  
  // 核心安全加固：对 subtitles 总长度进行校验 ---
  const MAX_SUBTITLES_LENGTH = 6000; // 设置最大总长度为 6000 字符
  const subtitlesText = subtitles.join('\n');
  if (subtitlesText.length > MAX_SUBTITLES_LENGTH) {
      console.warn(`[安全警告] 来自IP [${ip}] 的请求因字幕过长 (${subtitlesText.length} > ${MAX_SUBTITLES_LENGTH}) 而被拒绝。BV: ${bv}`);
      return new Response(JSON.stringify({ error: `字幕内容过长，最大允许 ${MAX_SUBTITLES_LENGTH} 字符。免费公共服务，请勿滥用` }), { status: 413, headers: corsHeaders }); // 413 Payload Too Large
  }

  // 无论结果如何，都将AI返回的【原始JSON】，包装后直接返回给客户端
  const sanitizedCommentText = (commentText || '').toString().slice(0, 50);
  const aiResultJson = await fetchAITimestamps(subtitlesText, sanitizedCommentText);
  if (typeof aiResultJson.noAd === 'boolean') {
      const responseToClient = { 
          success: true, 
          aiResult: aiResultJson,
      };
      return {status: 200, json: responseToClient};
  } else {
      return {status: 500, json: { error: 'AI返回的JSON内容无效', raw: aiResultJson}};
  }
}

// ----------- 入口handler -----------
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只支持POST' });
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    const result = await processRequest({ ...req.body, ip });
    return res.status(result.status).json(result.json);
  } catch (err) {
    console.error('错误：', err);
    return res.status(500).json({ error: '服务器内部错误' });
  }
};
