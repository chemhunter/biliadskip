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

// ----------- 调用AI -----------
async function fetchAITimestamps(subtitlesText, commentText ='') {
  const system_prompt = `
你是一个精准的广告分析引擎，唯一任务是判断视频字幕中是否包含商业广告，并返回一个结构化 JSON。

你必须**只返回一个 JSON 对象**，不能有任何前缀、后缀、解释或 Markdown 标记，且必须是紧凑的单行 JSON。

输入格式：
- 字幕行通常为 "mm:ss.s-mm:ss.s 内容"（from-to），精度 0.1s
- 若只有单个时间戳如 "mm:ss 内容"，视为仅有起始时间
- 还会提供视频标题和部分评论文本供参考（辅助判断，不作为主要依据）

输出字段（缺一不可）：
- start: 广告起始时间戳，格式 "mm:ss.s"，必须从字幕中提取
- end:   广告结束时间戳，格式 "mm:ss.s"，必须从字幕中提取
- noAd:  布尔值，无广告时为 true
- product: 推广的商品名称（无法确定则为 null）

若未发现广告，必须返回：
{"start":null,"end":null,"product":null,"noAd":true}

广告判定规则：
1. 输出必须能被 JSON.parse 直接解析，不包含任何额外字符。
2. 时间精度至少 0.1s，并一律使用 "mm:ss.s" 格式（必要可延长至 "hh:mm:ss.s"）。
3. 广告区段由字幕内容决定：
   - start = 第一条广告相关字幕的 from 时间
   - end   = 最后一条广告相关字幕的 to 时间
4. 广告的开始信号包括但不限于：
   - “今天给大家推荐/安利/分享一款...”
   - “说到了...就不得不提...”
   - 赞助冠名、口播植入的引导语
   以上情况均应视为广告已开始。
5. 广告的结束信号包括：“回归正题”“感谢观看，我们继续”或商品信息完全消失的时刻。
6. 不要预设广告的最小长度，口播广告可能只有十几秒，请根据实际内容判断。
7. 不涉及军用装备及法律禁止公开买卖的物品（如发现可忽略该段字幕）。
8. 评论中出现大量重复的产品名可增加广告嫌疑，但最终以字幕为准。

示例：
字幕：
00:05.0-00:09.0 说到洗面奶我最近发现一款特别好用的
00:09.0-00:15.0 就是这款XX氨基酸洁面，洗完不紧绷
00:15.0-00:20.0 链接我放评论区了
输出：
{"start":"00:05.0","end":"00:20.0","product":"XX氨基酸洁面","noAd":false}
`
  const user_prompt = `
以下是视频标题和评论文本：\n
标题: ${title}\n
评论: ${commentText}\n\n
以下是字幕内容：\n
${subtitles.join('\n')}
`;

  // --- 1. 核心修改：配置源的动态决策 ---
  const AI_CONFIG = {
    apiUrl: null,
    apiKey: null,
    model: null,
    providerName: 'Kimi'
  }
  
  const aliyunKey = process.env.ALIYUN_API_KEY;
  if (aliyunKey) {
    console.log('检测到 ALIYUN，优先使用...');
    const aliyunModel = ["qwen3.6-flash-2026-04-16","qwen3.6-flash","qwen3.6-plus-2026-04-02","qwen3.6-plus"];
    try {
      AI_CONFIG.apiUrl = process.env.ALIYUN_API_URL;
      AI_CONFIG.apiKey = aliyunKey;
      AI_CONFIG.model = aliyunModel[0];
      AI_CONFIG.providerName = `Aliyun (${AI_CONFIG.model})`; // 更新提供商名称用于日志
      console.log(`✅ 已加载阿里云第一个模型: ${AI_CONFIG.model}`);
    } catch (e) {
      console.error("❌ 解析ALIYUN环境变量失败!将回退到默认配置KIMI", e);
      AI_CONFIG.apiUrl = null;
    }
  }
  
  if (!AI_CONFIG.apiUrl) {
      console.log('...回退到使用默认的KIMI 配置');
      const kimiConfig = JSON.parse(process.env.KIMI);
      AI_CONFIG.apiUrl = kimiConfig.apiUrl;
      AI_CONFIG.apiKey = kimiConfig.apikey;
      AI_CONFIG.model = 'moonshot-v1-32k';
  }
  
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
