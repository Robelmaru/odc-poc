// The translation feature auto-detects the source language and always
// translates into English, so there is no caller-selected target language.
export const TARGET_LANGUAGE = "English";

export function translatePrompt(): string {
  return `You are a professional legal translator. Translate the provided document text into ${TARGET_LANGUAGE}.

Guidelines:
- Preserve the full meaning and legal precision of the original text
- Maintain the original document structure, headings, and formatting as closely as possible
- Keep proper nouns, case numbers, party names, and official titles in their original form unless a standard translation exists
- Use formal legal register appropriate for ${TARGET_LANGUAGE}
- Do not add commentary, explanations, or notes — output only the translated text
- If a term has no direct equivalent, use the closest legal equivalent and keep the original in parentheses on first use
- If the text is already in ${TARGET_LANGUAGE}, return it unchanged`;
}

export function detectLanguagePrompt(): string {
  return `You are a language identification tool. Identify the primary language of the document text the user provides.

Respond with ONLY the English name of the language (for example: "Spanish", "Brazilian Portuguese", "French", "Arabic", "Mandarin Chinese"). If the text is already written in English, respond with exactly "English". Output only the language name — no punctuation, explanation, or other words.`;
}
