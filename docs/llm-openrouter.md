# LLM no OpenRouter — qual modelo usar?

O MVP precisa de um modelo que:

1. **Siga o system prompt** (vocabulário limitado, persona da professora, sem português).
2. **Converse de forma natural** (tom de Speaking / videochamada, respostas curtas).
3. **Responda rápido** (aula ao vivo com microfone).
4. **Custe pouco** em muitas turmas/alunos.

## Modo 100% gratuito (sem créditos)

```env
OPENROUTER_MODEL=openrouter/free
OPENROUTER_APENAS_GRATUITOS=true
```

- **`openrouter/free`** — principal; funciona sem créditos na conta.
- **Fallbacks** só com sufixo `:free` (Gemma, Llama, etc.) — podem dar **429** (fila); o servidor tenta o próximo.
- Modelos **sem** `:free` (ex. `gemini-2.0-flash-001`, `deepseek-v4-flash:free` com 402) são **bloqueados** quando `OPENROUTER_APENAS_GRATUITOS=true`.

Alternativa zero custo: `LLM_PROVIDER=gemini` + chave gratuita do [Google AI Studio](https://aistudio.google.com/apikey).

## Recomendação principal (MVP)

| Prioridade | Modelo (slug OpenRouter) | Por quê |
|------------|--------------------------|---------|
| **1ª escolha** | `google/gemini-2.5-flash-preview` | Rápido, barato, bom em diálogo e instruções; próximo do que você já usava no Gemini Flash. |
| **2ª escolha** | `openai/gpt-4o-mini` | Muito estável em “seguir regras” e correções gentis; ótimo custo/benefício. |
| **3ª escolha** | `anthropic/claude-3.5-haiku` | Tom humano e respostas curtas; bom para aula ao vivo. |

Configure no `.env`:

```env
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=google/gemini-2.5-flash-preview
```

Reinicie: `node server.js`. O endpoint `GET /api/status` mostra `provedor` e `modelo` ativos.

## Se quiser máxima qualidade (mais caro)

| Modelo | Quando usar |
|--------|-------------|
| `anthropic/claude-sonnet-4` ou `~anthropic/claude-sonnet-latest` | Aluno avançado, prompts longos, menos “vazamento” de palavras fora do vocabulário. |
| `openai/gpt-4o` | Mesmo perfil; um pouco mais caro que Sonnet em alguns provedores. |

Use em produção só se Flash/Mini errarem muito o vocabulário — para a maioria dos alunos, Flash/Mini bastam.

## Automático (teste A/B)

`openrouter/auto` — o OpenRouter escolhe o modelo por prompt (NotDiamond). Útil para experimentar; em produção prefira slug fixo para comportamento previsível.

## Modelos a evitar para este caso

- Modelos **só de raciocínio** muito lentos (ex. Opus com reasoning alto) — atrasam a sala ao vivo.
- Modelos **muito pequenos/antigos** — ignoram lista de vocabulário com mais frequência.
- `openrouter/free` — imprevisível para regra rígida de vocabulário.

## Como comparar na prática

1. Mesma unidade (ex. 8), mesma frase do aluno: *"I go to school yesterday"*.
2. Avalie: correção gentil, só inglês, palavras dentro do vocabulário, uma pergunta no final.
3. Latência: &lt; 2–3 s na aula ao vivo.

Lista atualizada de slugs: https://openrouter.ai/models
