// api/analyze.js

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { bv, commentText } = req.body;

  if (!bv || !commentText) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // 1. 调用你的 AI 服务（用你自己的 API）
    const aiResp = await fetch(${process.env.apiUrl}, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.AI_API_KEY}`,
      },
      body: JSON.stringify({ text: commentText })
    });

    const aiData = await aiResp.json();
    const timestamp = aiData.timestamp_range;

    // 2. 写入 Supabase
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/ad_times`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": process.env.SUPABASE_API_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_API_KEY}`,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({
        bv,
        timestamp_range: timestamp,
        filteredSubtitles: commentText
      })
    });

    return res.status(200).json({ success: true, timestamp });
  } catch (e) {
    console.error("处理失败:", e);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
