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

export function buildTextTranslationPrompt(sourceLanguage: string, targetLanguage: string): string {
  const sourceLabel = sourceLanguage && sourceLanguage !== "Auto-detect" ? sourceLanguage : "the source language";
  return `You are a professional legal translator. Translate the provided text into ${targetLanguage}.

Guidelines:
- Preserve the full meaning and legal precision of the original text
- Keep proper nouns, case numbers, party names, and official titles in their original form unless a standard translation exists
- Use formal legal register appropriate for ${targetLanguage}
- Translate only the provided text — do not add commentary, explanations, or notes
- If the text is already in ${targetLanguage}, return it unchanged
- The source language is ${sourceLabel}.`;
}

export function buildTextTranslationRecord(targetLanguage: string, translation: string) {
  return {
    language: targetLanguage,
    languageName: targetLanguage,
    results: [{ filename: "Typed text", translation }],
  };
}

export function detectLanguagePrompt(): string {
  return `You are a language identification tool. Identify the primary language of the document text the user provides.

Respond with ONLY the English name of the language (for example: "Spanish", "Brazilian Portuguese", "French", "Arabic", "Mandarin Chinese"). If the text is already written in English, respond with exactly "English". Output only the language name — no punctuation, explanation, or other words.`;
}
