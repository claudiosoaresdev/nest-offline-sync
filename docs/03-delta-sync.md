````md
# Delta Sync (Sincronização Incremental) — Explicação completa

Este documento explica o conceito de **delta sync** (sincronização incremental) no contexto do seu projeto de **catálogo offline-first**.

---

## O problema que o delta sync resolve

Você tem um catálogo com algo como:

- ~3000 produtos
- cada produto tem imagem, nome, descrição
- e o **preço pode mudar frequentemente**

Se a cada vez que o app volta a ter internet você baixar o catálogo inteiro, você terá:

- muito consumo de banda
- mais tempo de carregamento
- mais custo no backend
- mais chance de travar dispositivos fracos

✅ A solução é: **baixar só o que mudou** desde a última sincronização.

Isso é o que chamamos de **delta sync**.

---

## Definição simples

**Delta sync** = sincronizar dados enviando apenas o **delta** (diferença / mudanças) entre:

- a versão que o cliente tem localmente
- e a versão atual do servidor

Em vez de enviar “tudo”, o servidor envia “as mudanças”.

---

## Snapshot vs Delta (dois modos de sync)

### 1) Snapshot (carga completa)
**Snapshot** é quando o cliente pede o catálogo inteiro.

Quando usar:
- primeira instalação do app
- cache local vazio / corrompido
- recuperação após erro

Exemplo:
- “Me manda todos os produtos (em páginas).”

### 2) Delta Sync (atualização incremental)
**Delta sync** é quando o cliente pede apenas as mudanças desde a última vez.

Quando usar:
- atualizações periódicas (ex.: a cada X minutos)
- sempre que voltar a internet
- sempre que abrir o app (se já existe cache local)

Exemplo:
- “Me manda tudo que mudou desde a versão 123.”

---

## A ideia central: um histórico de mudanças (Change Log)

Para existir delta sync, o servidor precisa ter um “histórico de mudanças”:

- toda vez que um produto muda, o servidor registra um evento
- esse evento tem uma numeração crescente

No seu projeto isso é:

- `ProductChange` (tabela de log)
- `ProductChange.version` (autoincrement): 1, 2, 3, 4...
- `CatalogState.currentVersion`: o último número (a versão mais recente do catálogo)

---

## O que é “versão” no delta sync?

Pense que o catálogo tem um “contador global”:

- quando qualquer produto muda:
  - cria um `ProductChange`
  - ele ganha um `version` novo (ex.: 124)
  - o catálogo passa a estar na versão 124

Então:

- **Versão do servidor:** `CatalogState.currentVersion`
- **Versão do cliente:** `sinceVersion` (última version aplicada no cache local)

---

## Como o cliente pede as mudanças

O cliente guarda uma variável local (por exemplo no IndexedDB/localStorage):

- `lastVersion`

Quando volta a ter internet, ele chama:

```http
GET /catalog/changes?sinceVersion=<lastVersion>
````

Exemplo:

```http
GET /catalog/changes?sinceVersion=123
```

---

## O que o servidor responde no delta sync

O servidor responde duas coisas:

1. qual é a versão atual do catálogo
2. quais mudanças aconteceram depois da versão do cliente

Exemplo de resposta:

```json
{
  "currentVersion": 130,
  "changes": [
    { "type": "UPSERT", "version": 124, "productId": "..." , "product": { ... } },
    { "type": "UPSERT", "version": 125, "productId": "..." , "product": { ... } },
    { "type": "DELETE", "version": 126, "productId": "..." }
  ]
}
```

Interpretando:

* “O catálogo está na versão **130**.”
* “Aqui estão as mudanças **124..126** que você não tem.”

Depois, o cliente aplica essas mudanças e atualiza:

* `lastVersion = 130`

---

## O que é UPSERT e DELETE no delta

O delta não envia “produtos”, ele envia **instruções**.

### UPSERT

Significa: **crie ou atualize** este produto no cache local.

Serve para:

* produto novo
* alteração de preço
* alteração de nome/imagem/estoque
* “restaurar” produto que estava deletado

No delta, UPSERT normalmente inclui o produto completo (ou pelo menos os campos necessários).

### DELETE

Significa: **remova** o produto do cache local (ou marque como deletado).

Serve para:

* produto removido do catálogo
* produto descontinuado

No seu banco você prefere **soft delete** (`deletedAt`), mas para o cliente é “remover”.

---

## Por que o Writer é essencial para o delta sync funcionar

O delta sync depende de uma regra de ouro:

> Qualquer mudança no catálogo deve criar um registro em `ProductChange`.

Se você atualizar preço direto em `ProductPrice` e **não** emitir change, o delta sync “não vê” a mudança.

Por isso existe o `CatalogWriterService`:

* ele é o “caminho oficial” para escrever no catálogo
* e garante que toda mudança gera change + atualiza versão global

---

## Fluxo completo recomendado no cliente (offline-first)

### Primeira vez (cache vazio): Snapshot + Delta pós-snapshot

1. Snapshot paginado:

```http
GET /catalog/snapshot?limit=200
GET /catalog/snapshot?limit=200&cursor=...
GET /catalog/snapshot?limit=200&cursor=...
```

2. O cliente guarda `baseVersion` do primeiro snapshot:

* `baseVersion = currentVersion` (da 1ª resposta)

3. Quando terminar todas as páginas, roda delta:

```http
GET /catalog/changes?sinceVersion=<baseVersion>
```

Por que esse passo extra?

* porque o catálogo pode ter mudado **enquanto você estava paginando o snapshot**
* esse delta final fecha a “janela” de consistência

4. Atualiza:

* `lastVersion = currentVersion` (do delta)

---

### Próximas vezes (cache já existe): Apenas Delta Sync

1. Cliente tem `lastVersion`
2. Ao voltar internet, chama:

```http
GET /catalog/changes?sinceVersion=<lastVersion>
```

3. Aplica changes em ordem:

* UPSERT → grava/atualiza produto local
* DELETE → remove do cache local

4. Atualiza:

* `lastVersion = currentVersion`

---

## Exemplo concreto (história rápida)

* Você baixa o snapshot hoje e termina com `lastVersion = 3000`.
* Amanhã o ERP altera preço de 8 produtos e remove 1 produto.
* O backend cria:

  * ProductChange 3001..3009

Quando o app volta online:

```http
GET /catalog/changes?sinceVersion=3000
```

Resposta vem com **9 changes** (em vez de 3000 produtos).

---

## Benefícios do delta sync

* ✅ Menos banda (baixa só o que mudou)
* ✅ Mais rápido (atualização quase instantânea)
* ✅ Melhor UX offline-first (cache local sempre pronto)
* ✅ Escala melhor (menos load no backend)
* ✅ Funciona bem com catálogos grandes e preços que mudam sempre

---

## Resumo em uma frase

**Delta sync** é um mecanismo de sincronização onde o cliente pede “todas as mudanças desde a minha última versão”, e o servidor retorna uma lista ordenada de instruções (UPSERT/DELETE) para atualizar o cache local sem baixar o catálogo inteiro.
