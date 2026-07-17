# Integrar a aula IA no site Talk Method

Quando o aluno clicar no botão/link na plataforma **Inglês Aprenda de Uma Vez**, ele deve abrir a sala de aula (estilo Google Meet) neste MVP.

## URL da sala

```
https://SEU_SERVIDOR/aula-ia.html?nome=NOME&unidade=NUMERO&alunoId=ID
```

| Parâmetro   | Obrigatório | Descrição |
|------------|-------------|-----------|
| `nome`     | Recomendado | Nome do aluno (saudação e tile “você”) |
| `unidade`  | Recomendado | Unidade Talk Method (1–110) — define professora e material |
| `alunoId`  | Recomendado | ID único do aluno na plataforma (sessão estável) |
| `estagio`  | Opcional    | `iniciante`, `intermediario` ou `avancado` (forçar professora) |
| `voltar`   | Opcional    | URL após “Sair” (padrão: área do aluno) |

### Exemplo (PHP na plataforma)

```php
<?php
$baseMvp = 'https://mvp.seudominio.com'; // ou http://localhost:3030 em dev
$url = $baseMvp . '/aula-ia.html?' . http_build_query([
    'nome'     => $aluno['nome'],
    'unidade'  => (int) $aluno['unidade_atual'],
    'alunoId'  => (string) $aluno['id'],
    'voltar'   => 'https://inglesaprendadeumavez.com/student-area/home',
]);
?>
<a href="<?= htmlspecialchars($url) ?>" class="btn btn-primary" target="_blank" rel="noopener">
  Praticar Speaking com a Professora IA
</a>
```

Sugestão de posição do link:

- Página da aula **Speaking** (`/student-area/class/...`)
- Home do aluno, ao lado da unidade atual
- Menu lateral “IA Speaking”

## O que o aluno vê

1. **Lobby** — nome, professora (Sofia / Emma / Kate) e unidade
2. **Sala ao vivo** — tile grande da professora, seu vídeo (opcional), timer, badge “Ao vivo”
3. **Conversa natural** — microfone (fala em inglês), texto no chat, voz da professora (TTS)
4. **Sair** — encerra sessão e volta para `voltar`

## Servidor

```bash
node server.js   # porta 3030
```

Variáveis:

- `OPENROUTER_API_KEY` + `LLM_PROVIDER=openrouter` (ou `GEMINI_API_KEY`) — ver `docs/llm-openrouter.md`
- `CORS_ORIGINS` — se embutir APIs em iframe de outro domínio, ex.: `https://inglesaprendadeumavez.com`

## Teste local

```
http://localhost:3030/aula-ia.html?nome=Maria&unidade=8&alunoId=teste-1
```
