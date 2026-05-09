'use strict';

const { isDeepStrictEqual } = require('node:util');

const { deepCopy, matchesFilter, sortDocuments } = require('./query');

function cloneDocuments(documents = []) {
  return documents.map((document) => deepCopy(document));
}

function sameDocuments(left = [], right = []) {
  return isDeepStrictEqual(left, right);
}

function requiresSubscriptionResync(query) {
  return typeof query?.limit === 'number';
}

function resolveSubscriptionChange({
  collection,
  query,
  previousDocuments = [],
  change,
}) {
  const documentId =
    typeof change?.documentId === 'string' && change.documentId.length > 0
      ? change.documentId
      : null;
  const previousDocument = documentId
    ? findDocumentById(previousDocuments, documentId)
    : null;

  switch (change?.operationType) {
    case 'insert':
      return resolveInsert({
        collection,
        query,
        previousDocuments,
        documentId,
        document: change.document,
      });
    case 'replace':
    case 'update':
      return resolveUpdate({
        collection,
        query,
        previousDocuments,
        previousDocument,
        documentId,
        document: change.document,
      });
    case 'delete':
      return resolveDelete({
        collection,
        previousDocuments,
        previousDocument,
        documentId,
      });
    default:
      return {
        documents: cloneDocuments(previousDocuments),
        payload: null,
      };
  }
}

function resolveInsert({
  collection,
  query,
  previousDocuments,
  documentId,
  document,
}) {
  if (!documentId || !document || !matchesFilter(document, query.filter)) {
    return {
      documents: cloneDocuments(previousDocuments),
      payload: null,
    };
  }

  const documents = normalizeDocuments(query, [
    ...removeDocumentById(previousDocuments, documentId),
    document,
  ]);

  if (!includesDocumentId(documents, documentId)) {
    return { documents, payload: null };
  }

  return {
    documents,
    payload: {
      type: 'realtime:insert',
      collection,
      document: deepCopy(document),
    },
  };
}

function resolveUpdate({
  collection,
  query,
  previousDocuments,
  previousDocument,
  documentId,
  document,
}) {
  if (!documentId) {
    return {
      documents: cloneDocuments(previousDocuments),
      payload: null,
    };
  }

  const nextSeed = removeDocumentById(previousDocuments, documentId);
  if (document && matchesFilter(document, query.filter)) {
    nextSeed.push(document);
  }

  const documents = normalizeDocuments(query, nextSeed);
  const isInNextResult = includesDocumentId(documents, documentId);

  if (!previousDocument && !isInNextResult) {
    return { documents, payload: null };
  }

  if (!previousDocument && isInNextResult) {
    return {
      documents,
      payload: {
        type: 'realtime:insert',
        collection,
        document: deepCopy(document),
      },
    };
  }

  if (!document) {
    return {
      documents,
      payload: {
        type: 'realtime:delete',
        collection,
        documentId,
      },
    };
  }

  return {
    documents,
    payload: {
      type: 'realtime:update',
      collection,
      document: deepCopy(document),
      before: deepCopy(previousDocument),
    },
  };
}

function resolveDelete({
  collection,
  previousDocuments,
  previousDocument,
  documentId,
}) {
  const documents = documentId
    ? removeDocumentById(previousDocuments, documentId)
    : cloneDocuments(previousDocuments);

  if (!previousDocument || !documentId) {
    return { documents, payload: null };
  }

  return {
    documents,
    payload: {
      type: 'realtime:delete',
      collection,
      documentId,
    },
  };
}

function normalizeDocuments(query, documents) {
  return sortDocuments(
    documents.filter(
      (document) => document && matchesFilter(document, query.filter),
    ),
    query.sort,
    query.limit,
  );
}

function removeDocumentById(documents, documentId) {
  return documents
    .filter((document) => document?._id !== documentId)
    .map((document) => deepCopy(document));
}

function findDocumentById(documents, documentId) {
  const document = documents.find(
    (candidate) => candidate?._id === documentId,
  );
  return document ? deepCopy(document) : null;
}

function includesDocumentId(documents, documentId) {
  return documents.some((document) => document?._id === documentId);
}

module.exports = {
  cloneDocuments,
  requiresSubscriptionResync,
  resolveSubscriptionChange,
  sameDocuments,
};
