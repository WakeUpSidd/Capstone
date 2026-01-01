"""
Minimal LLM client wrapper using Google Gemini.

Rationale:
- Use google-genai SDK (supported) for Gemini access.
- Keep interface tiny: call(system_prompt, user_prompt) -> str.
- No retries / no fallback.
"""

import os
from typing import Optional

try:
    from google import genai
    from google.genai import types
except Exception as e:  # pragma: no cover
    raise RuntimeError(
        "Missing dependency for Gemini client. Install 'google-genai' and remove 'google-generativeai'. "
        "Original import error: " + str(e)
    )


def call_llm(
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 1024,
    *,
    model_name: Optional[str] = None,
    temperature: float = 0.1,
) -> str:
    """
    Call Gemini LLM with system instruction and user prompt.
    """
    # Load API key lazily (after main.py sets env vars)
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("LLM_API_KEY")
    model_name = model_name or os.getenv("GEMINI_MODEL")
    
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY or LLM_API_KEY must be set in environment")
        
    if not model_name:
        raise RuntimeError("GEMINI_MODEL must be set in environment")

    try:
        client = genai.Client(api_key=api_key)

        response = client.models.generate_content(
            model=model_name,
            contents=user_prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=temperature,
                max_output_tokens=max_tokens,
            ),
        )

        # Prefer the SDK's convenience property
        result = getattr(response, "text", None)
        if result:
            return result

        # Fallback: attempt to extract from candidates (SDK shape can vary across versions)
        candidates = getattr(response, "candidates", None) or []
        if not candidates:
            raise RuntimeError("Gemini returned no candidates.")

        candidate0 = candidates[0]
        content = getattr(candidate0, "content", None)
        parts = getattr(content, "parts", None) if content else None
        if parts:
            text0 = getattr(parts[0], "text", None)
            if text0:
                return text0

        raise RuntimeError("Gemini returned empty response")

    except Exception as e:
        raise RuntimeError(f"Gemini API error: {str(e)}")
