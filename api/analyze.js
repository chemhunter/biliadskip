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

// ----------- 调用AI -----------
async function fetchAITimestamps(subtitles, commentText ='') {
  const reqBody = {
    model: 'moonshot-v1-32k',
    messages: [
        {
          role: 'system',
          content: '你是一个电商专家，识别广告时间段'
        },
        {
          role: 'user',
          content: `分析以下字幕，告诉我广告部分的起止时间戳，若未发现广告直接回复“无广告”。
             广告部分一般不低于30秒，也有例外。如果你发现多段广告，回复我最像商业合作的那一段。
             博主聊与视频主题无关的内容，比如自己身边的事，将这些引入广告的先导部分也看做广告。
             如果我发你的字幕时间戳不是从00:00开始的，说明发给你的是经我初筛过的疑似广告部分。
             将最后一条广告字幕接下来的下一条正常字幕的时间减去1s作为结束时间戳。
             发现广告的话仅回复广告时间戳和产品名称，不要回复其他内容。
             返回格式：\n广告开始 xx:xx, 广告结束 xx:xx ，产品：xx\n\n${subtitles.join('\n')}\n\n
             下面是评论区置顶广告文本，供你参考以精准识别广告：\n${commentText}`
        },
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

  const check = await checkAndUpdateBVCall(bv);
  if (!check.allowed) {
    return { status: 403, json: { error: check.reason } };
  }

  const sanitizedCommentText = (commentText || '').toString().slice(0, 100);
  const aiResp = await fetchAITimestamps(subtitles, sanitizedCommentText);
  if (!aiResp) {
      return { status: 500, json: { error: 'AI服务未返回有效内容' } };
  }
  
  if (aiResp.includes('无广告')) {
      return { status: 200, json: { success: true, timestamp_Obj: null, message: '无广告' } };
  }  
  
  if (!aiResp.includes(':')) {
    return { status: 500, json: { error: 'AI 返回格式异常' } };
  }

  const timestamp_Obj = extractTimestamp(aiResp);
  if (!timestamp_Obj) {
    return { status: 200, json: { success: false, error: 'AI返回内容未检测到时间戳' } };
  }

  const inserted = await uploadAdTimestamp({
    bv,
    timestamp_range: `${timestamp_Obj.start} - ${timestamp_Obj.end}`,
    source: 'kimiAI_Vercel',
    user_id,
    UP_id,
  });

  if (!inserted) {
    return { status: 500, json: { error: '数据库写入失败' } };
  }

  return { status: 200, json: { success: true, timestamp_Obj, raw: aiResp } };
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
