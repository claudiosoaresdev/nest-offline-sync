/* eslint-disable @typescript-eslint/no-unsafe-return */
import { faker } from '@faker-js/faker';
import { PrismaPg } from '@prisma/adapter-pg';

import {
  CatalogChangeType,
  Currency,
  PrismaClient,
  type Product,
} from '../src/generated/prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

const TOTAL_PRODUCTS = 3000;
const FAKER_SEED = 12345;

// url de imagem fake só pra catálogo (troca depois por CDN)
function imageUrl(i: number) {
  return `https://picsum.photos/seed/product-${i}/600/600`;
}

async function main() {
  faker.seed(FAKER_SEED);

  // 1) garante CatalogState (singleton)
  await prisma.catalogState.upsert({
    where: { id: 'global' },
    update: {},
    create: { id: 'global', currentVersion: 0 },
  });

  // 2) LIMPAR catálogo (dev only)
  // Se você já tiver pedidos/itens/eventos no banco, e quiser manter, remova deletes de Order*.
  await prisma.productChange.deleteMany({});
  await prisma.inventory.deleteMany({});
  await prisma.productPrice.deleteMany({});
  await prisma.product.deleteMany({});

  await prisma.catalogState.update({
    where: { id: 'global' },
    data: { currentVersion: 0 },
  });

  // 3) cria 3000 produtos
  // OBS: createMany não devolve IDs no Prisma, então usamos create em lote via transaction.
  const created: Array<
    Pick<Product, 'id' | 'sku' | 'name' | 'description' | 'imageUrl'>
  > = await prisma.$transaction(
    Array.from({ length: TOTAL_PRODUCTS }, (_, idx) => {
      const i = idx + 1;

      return prisma.product.create({
        data: {
          sku: `SKU-${String(i).padStart(6, '0')}`,
          name: faker.commerce.productName(),
          description: faker.commerce.productDescription(),
          imageUrl: imageUrl(i),
        },
        select: {
          id: true,
          sku: true,
          name: true,
          description: true,
          imageUrl: true,
        },
      });
    }),
  );

  // 4) cria preços + estoque + changes
  // aqui já temos os UUIDs corretos
  const pricesData: Array<{
    productId: string;
    priceCents: number;
    currency: Currency;
  }> = created.map((p) => ({
    productId: p.id, // FK = UUID do produto
    priceCents: faker.number.int({ min: 199, max: 199_999 }),
    currency: Currency.BRL,
  }));

  const inventoryData: Array<{
    productId: string;
    stockOnHand: number;
  }> = created.map((p) => ({
    productId: p.id,
    stockOnHand: faker.number.int({ min: 0, max: 200 }),
  }));

  const changesData: Array<{
    type: CatalogChangeType;
    productId: string;
    payload: {
      product: {
        id: string;
        sku: string | null;
        name: string;
        description: string | null;
        imageUrl: string | null;
      };
      price: {
        priceCents: number;
        currency: Currency;
      };
      inventory: {
        stockOnHand: number;
      };
    };
  }> = created.map((p, idx) => ({
    type: CatalogChangeType.UPSERT,
    productId: p.id,
    payload: {
      product: {
        id: p.id,
        sku: p.sku,
        name: p.name,
        description: p.description,
        imageUrl: p.imageUrl,
      },
      price: {
        priceCents: pricesData[idx]?.priceCents ?? 0,
        currency: pricesData[idx]?.currency ?? Currency.BRL,
      },
      inventory: {
        stockOnHand: inventoryData[idx]?.stockOnHand ?? 0,
      },
    },
  }));

  await prisma.$transaction(async (tx) => {
    await tx.productPrice.createMany({ data: pricesData });
    await tx.inventory.createMany({ data: inventoryData });
    await tx.productChange.createMany({ data: changesData });
  });

  // 5) atualiza currentVersion para o último change
  const last: { version: number } | null = await prisma.productChange.findFirst(
    {
      orderBy: { version: 'desc' },
      select: { version: true },
    },
  );

  const currentVersion: number = last ? last.version : 0;

  await prisma.catalogState.update({
    where: { id: 'global' },
    data: { currentVersion },
  });

  console.log(
    `Seed OK ✅ products=${TOTAL_PRODUCTS} currentVersion=${currentVersion}`,
  );
}

main()
  .catch((e) => {
    console.error('Seed failed ❌', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
