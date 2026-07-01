export async function transcribeAudio(audioBuffer, env) {
    const response = await env.AI.run('@cf/openai/whisper', { audio: [...audioBuffer] });
    return response.text;
}