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
async function queryBvCallAi(bvNumber) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/bv_calls?bv=eq.${bvNumber}`;
  const headers = {
    apikey: process.env.SUPABASE_API_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_API_KEY}`,
  };
  const resp = await fetch(url, { headers });
  return resp.ok ? await resp.json() : null;
}

async function updateBvCallTimes(bvNumber, newTimes) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/bv_calls?bv=eq.${bvNumber}`;
  const headers = {
    apikey: process.env.SUPABASE_API_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_API_KEY}`,
    'Content-Type': 'application/json',
  };
  const resp = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ call_times: newTimes }),
  });
  return resp.ok;
}

async function insertBvCall(bvNumber) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/bv_calls`;
  const headers = {
    apikey: process.env.SUPABASE_API_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_API_KEY}`,
    'Content-Type': 'application/json',
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ bv: bvNumber, call_times: 1 }),
  });
  return resp.ok;
}

async function checkAndUpdateBVCall(bvNumber) {
  const data = await queryBvCallAi(bvNumber);
  if (data && data.length > 0) {
    if (data[0].call_times >= 2) {
      return { allowed: false, reason: '该BV号已超出调用次数限制' };
    }
    const updated = await updateBvCallTimes(bvNumber, data[0].call_times + 1);
    if (!updated) throw new Error('更新调用次数失败');
  } else {
    const inserted = await insertBvCall(bvNumber);
    if (!inserted) throw new Error('插入调用记录失败');
  }
  return { allowed: true };
}

async function checkEnoughRecords(bvNumber) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/bili_ad_timestamps_public?bv=eq.${bvNumber}`;
  const headers = {
    apikey: process.env.SUPABASE_API_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_API_KEY}`,
  };
  const resp = await fetch(url, { headers });
  if (!resp.ok) return false;
  const data = await resp.json();
  return data.length >= 5;
}

/* 移除该逻辑
async function uploadAdTimestamp({ bv, timestamp_range, source, user_id, UP_id }) {
    const url = "https://akoaopeqigjwpcksqdyf.supabase.co/functions/v1/biliadskip";
    const headers = {'Content-Type': 'application/json'};
    const body = {bv, timestamp_range, source, user_id, UP_id};
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
async function fetchAITimestamps(subtitles, commentText ='') {
  const system_prompt = `
   你是一个精准的广告分析引擎。
   你的唯一任务是分析用户提供的视频字幕和评论区文本，判断其中是否包含商业广告，并返回一个结构化的JSON对象。
   你的回复【必须】是一个合法的、可以被JSON.parse()解析的JSON对象，不要包含任何额外的解释或Markdown标记。

   该JSON对象必须包含以下字段:
     - "start": 广告的起始时间戳 (格式 "mm:ss")。如果无广告，则为 null。
     - "end": 广告的结束时间戳 (格式 "mm:ss")。如果无广告，则为 null。
     - "noAd": 一个布尔值，如果确定无广告则为 true，否则为 false。
     - "product": 广告中推广的商品或服务名称。如果无广告，则为 null。

  判断规则：
    1. 你的回复【必须】是一个合法的、可以被JSON.parse()解析的JSON对象。
    2. 不要回复任何JSON对象之外的额外文字、解释或注释。
    3. 如果在字幕中找到明确的商业推广，请填写 "start", "end", "product" 字段，并将 "noAd" 设为 false。
    4. 如果在仔细分析后，确定字幕中【没有】任何商业推广，返回{"start": null, "end": null, "product": null, "noAd": true}。
    5. 博主身边的故事这类与主题无关的内容，将这些引入广告的先导部分也视做广告。将最后一条广告字幕接下来的下一条正常字幕的时间减去1s作为"end"时间戳。
`
  const user_prompt = `
    分析以下视频字幕内容：\n
    ${subtitlesText}\n
    以下是可能包含线索的评论区文本，供你参考：
    ${commentText}
    `
  const reqBody = {
    model: 'moonshot-v1-8k',
    messages: [
        { role: 'system', content: system_prompt },
        { role: 'user', content: user_prompt },
    ],
    temperature: 0.3,
    max_tokens: 100,
  };

  const resp = await fetch(process.env.AI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.AI_API_KEY}`,
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
        const errorMessage = `AI 请求失败! 
            状态码 (Status Code): ${resp.status} ${resp.statusText}
            响应体 (Response Body): ${errorBody}
            请求目标URL: ${process.env.AI_API_URL}
        `;
        throw new Error(errorMessage);
    }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || null;
}

// ----------- 业务主流程 -----------
async function processRequest({bv, subtitles, user_id, UP_id, ip, commentText}) {
  if (!bv || !Array.isArray(subtitles) || subtitles.length === 0) {
    return { status: 400, json: { error: '缺少必要字段' } };
  }
  const avNumber = decodeBV(bv);
  if (avNumber === null) {
    return { status: 400, json: { error: 'BV号无效' } };
  }

  if (await checkEnoughRecords(bv)) {
    return { status: 200, json: { success: true, message: '记录已足够，无需再次调用AI' } };
  }

    // --- 1. 核心安全加固：对 subtitles 总长度进行校验 ---
  const MAX_SUBTITLES_LENGTH = 6000; // 设置最大总长度为 6000 字符
  const subtitlesText = subtitles.join('\n');
  if (subtitlesText.length > MAX_SUBTITLES_LENGTH) {
      console.warn(`[安全警告] 来自IP [${ip}] 的请求因字幕过长 (${subtitlesText.length} > ${MAX_SUBTITLES_LENGTH}) 而被拒绝。BV: ${bv}`);
      return new Response(JSON.stringify({ error: `字幕内容过长，最大允许 ${MAX_SUBTITLES_LENGTH} 字符。免费公共服务，请勿滥用` }), { status: 413, headers: corsHeaders }); // 413 Payload Too Large
  }
  
  const check = await checkAndUpdateBVCall(bv);
  if (!check.allowed) {
    return { status: 403, json: { error: check.reason } };
  }

  const sanitizedCommentText = (commentText || '').toString().slice(0, 50);
  const aiRespText = await fetchAITimestamps(subtitlesText, sanitizedCommentText);

  if (!aiRespText) {
      return { status: 500, json: { error: 'AI服务未返回任何内容' } };
  }

  // --- 核心修改：直接解析JSON，不再需要正则表达式 ---
  let aiResultJson;
  try {
      aiResultJson = JSON.parse(aiRespText);
  } catch (e) {
      console.error("JSON解析失败!", aiRespText);
      return { status: 500, json: { error: 'AI返回的不是有效的JSON', raw: aiRespText } };
  }

  let responseToClient;
  if (aiResultJson.noAd === true) {
      responseToClient = { success: true, timestamp_Obj: null, message: '无广告' };
  } else if (aiResultJson.start && aiResultJson.end) {
      responseToClient = { 
          success: true, 
          timestamp_Obj: {
              start: aiResultJson.start,
              end: aiResultJson.end
          },
          product: aiResultJson.product // (可选) 也可以将产品名称返回
      };
  } else {
      return { status: 500, json: { error: 'AI返回的JSON内容无效', raw: aiResultJson } };
  }

  return { status: 200, json: responseToClient };
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
