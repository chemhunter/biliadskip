export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const { bv, commentText } = req.body;

  console.log('[🧠 AI 分析请求]', bv, commentText);

  // TODO: 替换为你自己的 AI 调用逻辑
  const aiResult = {
    timestamp: '03:36 - 05:04',
    filtered: commentText.slice(0, 200), // 示例：返回部分字幕
  };

  // 可选：写入 Supabase
  // await supabase.from('ad_times').insert({ bv, ...aiResult });

  return res.status(200).json(aiResult);
}
