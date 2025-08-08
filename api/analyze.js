// api/analyze.js

function extractTimestamp(text) {
  const match = text.match(/(\d{1,2}:\d{2}(?::\d{2})?)[^\d]+(\d{1,2}:\d{2}(?::\d{2})?)/);
  if (!match) return null;
  return { start: match[1], end: match[2] };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
  // 处理 CORS 预检请求
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end(); // 204 No Content
  }

  // 设置 CORS 响应头，允许跨域访问
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
               .split(',')[0]
               .trim();
  // 解析 body
  const { bvNumber, subtitles, user_id, UP_id} = req.body;

  if (!bvNumber || !Array.isArray(subtitles) || subtitles.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // 0. 检查是否已存在 5 条记录，避免重复调用 AI
    const existingResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bili_ad_timestamps?bv=eq.${bvNumber}`, {
      headers: {
        "apikey": process.env.SUPABASE_API_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_API_KEY}`
      }
    });
    const existingData = await existingResp.json();
    if (existingData.length >= 5) {
      return res.status(200).json({ success: true, message: 'Already has enough records' });
    }

    // 1. 构造 AI 请求内容（参考你的油猴脚本）
    const requestData = {
      model: "moonshot-v1-auto",
      messages: [
        {
          role: 'system',
          content: '你是一个视频字幕分析助手，能够识别广告时间段'
        },
        {
          role: 'user',
          content: `请分析以下视频字幕，分析哪段是口播广告部分，告诉我广告部分的起止时间戳，广告长度一般不低于30秒，
          且一般不会出现在视频的前3分钟,也有例外。仅回复广告时间戳，不要回复其他内容。若有多个广告时间段，返回最像商业合作的一段。
          返回格式：\n广告开始 xx:xx \n广告结束 xx:xx \n\n${subtitles.join('\n')}`
        }
      ],
      temperature: 0.3,
      max_tokens: 100
    };

    // 2. AI 请求逻辑
    let aiResponseText = null;
    
    try {
      const aiResp = await fetch(`${process.env.AI_API_URL}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.AI_API_KEY}`
        },
        body: JSON.stringify(requestData)
      });
    
      if (!aiResp.ok) {
        const errJson = await aiResp.json().catch(() => ({}));
        console.error("AI 请求失败：", errJson);
        return res.status(500).json({ error: 'AI 请求失败' });
      }
    
      const aiJson = await aiResp.json();
      aiResponseText = aiJson.choices?.[0]?.message?.content;
      console.log(bvNumber, "kimi 返回：", aiResponseText);
    } catch (err) {
      console.error("AI 请求异常：", err);
      return res.status(500).json({ error: 'AI 请求异常' });
    }

    if (!aiResponseText) {
      return res.status(500).json({ error: 'AI 无响应内容' });
    }
    
    if (typeof aiResponseText !== 'string' || !aiResponseText.includes(':')) {
      return res.status(500).json({ error: 'AI 返回格式异常' });
    }
    
    // 3. 提取时间戳
    const timestamp_Obj = extractTimestamp(aiResponseText);
    if (!timestamp_Obj) {
      return res.status(200).json({ success: false, error: "AI 返回中未检测到时间戳" });
    }

    // 4. 写入 Supabase
    const supaResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bili_ad_timestamps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": process.env.SUPABASE_API_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_API_KEY}`,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({
        bv: bvNumber,
        timestamp_range: `${timestamp_Obj.start} - ${timestamp_Obj.end}`,
        source: 'cloudAIbyVercel',
        user_id,
        UP_id,
        ip,
      })
    });

    if (!supaResp.ok) {
      const supaErr = await supaResp.text();
      console.error("写入 Supabase 失败：", supaErr);
      return res.status(500).json({ error: 'Supabase 写入失败' });
    }

    return res.status(200).json({ success: true, timestamp_Obj, raw: aiResponseText });

  } catch (err) {
    console.error("处理失败：", err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
