const { SQS, S3 } = require('aws-sdk');
const { Consumer } = require('sqs-consumer');
const tmp = require('tmp');
const fs = require('fs');
const util = require('util');
const { exec } = require('child_process');

const execPromise = util.promisify(exec);

const s3 = new S3();
const sqs = new SQS();

const app = Consumer.create({
  queueUrl: process.env.VIRUS_SCAN_QUEUE_URL,
  handleMessage: async (message) => {
    console.log('message', message);
    const parsedBody = JSON.parse(message.Body);
    const scanBucket = parsedBody.Records[0].s3.bucket.name
    const documentKey = parsedBody.Records[0].s3.object.key.replace(/\+/g, " ");
    
    const { Body: fileData } = await s3.getObject({
      Bucket: scanBucket,
      Key: documentKey
    }).promise();

    const inputFile = tmp.fileSync({
      mode: 0o644,
      tmpdir: process.env.TMP_PATH,
    });
    fs.writeSync(inputFile.fd, Buffer.from(fileData));
    fs.closeSync(inputFile.fd);

    try {
      await execPromise(`clamdscan ${inputFile.name}`);

      await s3.putObject({
        Body: fileData,
        Bucket: process.env.CLEAN_BUCKET,
        Key: documentKey,
        Tagging: 'AV_SCAN=CLEAN',
      }).promise();

      await s3.deleteObject({
        Bucket: scanBucket,
        Key: documentKey,
      }).promise();

    } catch (e) {
      if (e.code === 1) {
        await s3.putObjectTagging({
          Bucket: process.env.QUARANTINE_BUCKET,
          Key: documentKey,
          Tagging:'AV_SCAN=INFECTED',
        }).promise();
      }
    } finally {
      await sqs.deleteMessage({
        QueueUrl: process.env.VIRUS_SCAN_QUEUE_URL,
        ReceiptHandle: message.ReceiptHandle
      }).promise();
    }
  },
  sqs: new SQS()
});

app.on('error', (err) => {
  console.error('err', err.message);
});

app.on('processing_error', (err) => {
  console.error('processing error', err.message);
});

app.on('timeout_error', (err) => {
 console.error('timeout error', err.message);
});

app.start();