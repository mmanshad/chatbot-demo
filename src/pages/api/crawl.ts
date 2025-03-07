import { PineconeClient, Vector } from "@pinecone-database/pinecone";
import Bottleneck from "bottleneck";
import { Document } from "langchain/document";
import { OpenAIEmbeddings } from "langchain/embeddings";
import { TokenTextSplitter } from "langchain/text_splitter";
import { NextApiRequest, NextApiResponse } from "next";
import { uuid } from "uuidv4";
import { Crawler, Page } from '../../crawler';
import axios from 'axios';
const limiter = new Bottleneck({
  minTime: 2000
});

let pinecone: PineconeClient | null = null

const initPineconeClient = async () => {
  pinecone = new PineconeClient();
  console.log("init pinecone")
  await pinecone.init({
    environment: process.env.PINECONE_ENVIRONMENT!,
    apiKey: process.env.PINECONE_API_KEY!,
  });
}

type Response = {
  message: string
}

const projectId = process.env.PINECONE_PROJECTID!;
const evn = process.env.PINECONE_ENVIRONMENT!;
const indexName = process.env.PINECONE_INDEX_NAME!;

const doUpsert = async (vectors: Vector[]) => {
  const endpoint = `https://${indexName}-${projectId}.svc.${evn}.pinecone.io/vectors/upsert`;
  const headers = {
    'accept': 'application/json',
    'Api-Key': process.env.PINECONE_API_KEY!
  };
  const response = await axios.post(endpoint, { vectors }, { headers });
  return response.data;
};


const truncateStringByBytes = (str: string, bytes: number) => {
  const enc = new TextEncoder();
  return new TextDecoder("utf-8").decode(enc.encode(str).slice(0, bytes));
};

const sliceIntoChunks = (arr: Vector[], chunkSize: number) => {
  return Array.from({ length: Math.ceil(arr.length / chunkSize) }, (_, i) =>
    arr.slice(i * chunkSize, (i + 1) * chunkSize)
  );
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Response>
) {
  if (!process.env.PINECONE_INDEX_NAME) {
    res.status(500).json({ message: "PINECONE_INDEX_NAME not set" })
    return
  }

  const { query } = req;
  const { urls: urlString, limit } = query;
  const urls = (urlString as string).split(",");
  const crawlLimit = parseInt(limit as string) || 100;
  const pineconeIndexName = process.env.PINECONE_INDEX_NAME

  if (!pinecone) {
    await initPineconeClient();
  }

  const crawler = new Crawler(urls, crawlLimit, 200)
  const pages = await crawler.start() as Page[]
  console.log(pages.length)

  const documents = await Promise.all(pages.map(row => {
    const splitter = new TokenTextSplitter({
      encodingName: "gpt2",
      chunkSize: 300,
      chunkOverlap: 20,
    });

    const docs = splitter.splitDocuments([
      new Document({ pageContent: row.text, metadata: { url: row.url, text: truncateStringByBytes(row.text, 36000) } }),
    ]);
    return docs
  }))

  const index = pinecone && pinecone.Index(pineconeIndexName);
  const embedder = new OpenAIEmbeddings({
    modelName: "text-embedding-ada-002"
  })

  //Embed the documents
  const getEmbeddings = async () => {
    return await Promise.all(documents.flat().map(async doc => {
      const embedding = await embedder.embedQuery(doc.pageContent)
      console.log("done embedding", doc.metadata.url)
      return {
        id: uuid(),
        values: embedding,
        metadata: {
          chunk: doc.pageContent,
          text: doc.metadata.text as string,
          url: doc.metadata.url as string,
        }
      } as Vector
    }))
  }

  let vectors: Vector[] = []

  try {
    vectors = await limiter.schedule(getEmbeddings) as unknown as Vector[]
  } catch (e) {
    res.status(500).json({ message: JSON.stringify(e) })
  }

  const chunks = sliceIntoChunks(vectors, 10)

  /*
  await Promise.all(chunks.map(async chunk => {
    index && await index.upsert({
      upsertRequest: {
        vectors: chunk as Vector[]
      }
    })
  }))
  */

  await Promise.all(chunks.map(async chunk => {
    await doUpsert(chunk as Vector[]);
  }));

  res.status(200).json({ message: "Done" })
}