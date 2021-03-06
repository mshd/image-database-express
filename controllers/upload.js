/**
 * GET /api/upload
 * File Upload API example.
 */
const wdk = require('wikidata-sdk');
const fs = require('fs');
const request = require('request');
const crypto = require('crypto');
const sharp = require('sharp');
const smartcrop = require('smartcrop-sharp');
const FileType = require('file-type');
const facecrop = require('./facecrop');

const {
  simplify, parse, isEntityId, isPropertyId, getNumericId
} = require('wikibase-sdk');
const getItem = require('./wikidata/getItem');
const getRelatives = require('./wikidata/getRelatives');

const Image = require('../models/Image');


/**
 * GET /api
 * List of API examples.
 */
exports.getFunctions = (req, res) => {
  res.render('image/functions', {
    title: 'Choose an option'
  });
};

function getRandomFilename() {
  return crypto.randomBytes(20).toString('hex');
}

const download = async (url, path) => {
  await new Promise(resolve =>
    request.head(url, (err, res, body) => {
      request(url)
        .pipe(fs.createWriteStream(path))
        .on('close', resolve);
    })
  );

  const fileType = await FileType.fromFile(path);
  console.log(fileType);

  if(!fileType){
    throw 'no image';
  }
  if( fileType.mime.substr(0,5) !== 'image'){
    throw 'no image';
  }

};

function applySmartCrop(src, dest, width, height) {
  return smartcrop.crop(src)
    .then(function(result) {
      const crop = result.topCrop;
      return sharp(src)
        .extract({ width: crop.width, height: crop.height, left: crop.x, top: crop.y })
        .resize(200)
        .toFile(dest);
    })
}

exports.reloadThumbnails=  async (req, res) => {
  if(!req.user || req.user.role !== 'admin'){
    return;
  }
  const image = await Image.find({ uploadSite: req.hostname });
  for(let i=0;i<image.length;i++) {
    console.log(image[i].id);
    await createThumbnail(image[i].id, image[i].mimetype);
  }
  req.flash('success', { msg: 'All thumbnails will be reloaded' });
  res.redirect('/admin/images');
};

async function createThumbnail(filename,filetype='image/jpeg'){

  try {
    applySmartCrop('uploads/original/' + filename, 'uploads/thumbnail/' + filename, 200, 200);

    await facecrop(`./uploads/original/${filename}`, `./uploads/facecrop/${filename}`,filetype, 0.9, 1.7, './controllers/resources/haarcascade_frontalface_alt_tree.xml');

  }catch (e) {
    req.flash('errors', { msg: 'Facecrop failed.' });
    // console.log(e);
  }
  // console.log('Create thumb: uploads/' + filename);
  // sharp('uploads/cropped/' + filename).resize(200).toFile('uploads/thumbnail/' + filename, (err, resizeImage) => {
  //   if (err) {
  //     console.log(err);
  //   } else {
  //     console.log(resizeImage);
  //   }
  // });
}
exports.uploadWikimediaFile = async (req, id) => {
  const qid = "Q"+id;
  const wikidataEntities = await getItem([qid], 'en');
  // const label = wdk.simplify.labels(wikidataEntities[qid].labels).en;
  const claims = wdk.simplify.claims(wikidataEntities[qid].claims);
  const images = claims.P18;
  if(!images.length){
    return null;
  }
  const imageUrl = 'https://commons.wikimedia.org/wiki/Special:FilePath/'+ images[0];
  let imageDetails = {
    wikidataEntity: getNumericId(qid),
    wikidataLabel: wdk.simplify.labels(wikidataEntities[qid].labels).en,
    sourceUrl: imageUrl,
    sourceName: "commons.wikimedia.org",
    uploadSite: req.hostname,
    originalFilename: images[0],
    viewCount: 0,
    // createdBy: req.user,
    mimetype: 'image/jpeg'
  };
  var image = new Image(imageDetails);
  var savedImage = await image.save();
  var savedImageId = savedImage.id;
  await download(imageUrl, "uploads/original/" + savedImageId);
  await createThumbnail(savedImageId,imageDetails.mimetype);
  return true;
};


exports.getMultiFileUpload = async (req, res) => {
  // res.send(req.params);

  if (!req.query.ids) {
    // req.flash('errors', { msg: 'Parameter ids is missing' });
    // res.redirect('/image/single_upload');
    res.render('image/multiUploadForm', {
      title: 'File Upload',
    });
    return;
  }
  const ids = req.query.ids.split(",");
  // for(let id in ids){
  //   if (!isEntityId(id)) {
  //     req.flash('errors', { msg: 'Some ids are invalid.' });
  //     res.redirect('/image/single_upload');
  //   }
  // }

  //
  const wikidataEntities = await getItem(ids, 'en');
  let entities = [];
  // for(var id, enty in wikidataEntities){
  for(var i in wikidataEntities) {
    var label = wdk.simplify.labels(wikidataEntities[i].labels).en;
    var claims = wdk.simplify.claims(wikidataEntities[i].claims);
    var existing = await Image.find({ wikidataEntity: getNumericId(i) }, null, { sort: { name: 1 }, limit: 1 });
    entities.push({
      id: i,
      link: wdk.getSitelinkUrl({ site: 'wikidata', title: i }),
      images: claims.P18,
      existing: existing,
      label: label,
    });
  }
  // const label = wdk.simplify.labels(wikidataInfo[wikidataId].labels).en;
  res.render('image/multiUpload', {
    title: 'File Upload',
    entities: entities
    // query: req.query
  });
};


exports.handlePersonSelect = async (req, res, next) => {

  //A person is selected, forward
  if(req.body.wikidataEntityId !== undefined){
    const response = await getRelatives(req.body.wikidataEntityId);
    const result = wdk.simplify.sparqlResults(response.data, { minimize: false });
    const ids = result.map(entry => {
      return entry.item.value;
    });
    res.redirect('/image/multi_upload?ids='+ids.slice(0,50).join(","));
    return;
  }
  next();

};

exports.handleMultiUrlUpload = async (req, res, next) => {

  const urls = req.body.sourceUrl;
  if(urls === undefined){
    req.flash('errors', {msg: 'Nothing.'});
    res.redirect(req.header('Referer') || '/');
    return;
  }
  const wikidataInfo = await getItem(Object.keys(urls), 'en');
  let uploadedCount = 0;
  for(let wikidataId in urls) {
    try {
      var file = getRandomFilename();
      var sourceUrl = urls[wikidataId];
      if(sourceUrl) {
        // , () => {
          // res.savedUrl = file;
          let imageDetails = {
            wikidataEntity: getNumericId(wikidataId),
            wikidataLabel: wdk.simplify.labels(wikidataInfo[wikidataId].labels).en,
            sourceUrl: sourceUrl,
            internalFileName: file,
            uploadSite: req.hostname,
            // originalFilename: sourceUrl
            viewCount: 0,
            createdBy: req.user,
          };
          imageDetails.mimetype = 'image/jpeg';
          var image = new Image(imageDetails);
          var savedImage = await image.save();
          var savedImageId = savedImage.id;
          await download(sourceUrl, "uploads/original/" + savedImageId);
          createThumbnail(savedImageId,imageDetails.mimetype);
          uploadedCount++;
        // });
        // next();
      }

    } catch (err) {

      //Try to delete the entry.
      try {
        await Image.deleteOne({id: image.id});
      }catch (e) {
        console.log(e);
      }
      req.flash('errors', {msg: 'URL invalid.'});
      res.redirect(req.header('Referer') || '/');
      return;
    }
  }
  req.flash('success', { msg: `${uploadedCount} files uploaded.` });
  res.redirect(req.header('Referer') || '/');
  return;

};

exports.loginFirst = (req, res, next) => {
  if(!req.user) {
    req.flash('errors', {msg: 'Please login before uploading images.'});
    // res.redirect('/login');
  }
  next();
};

exports.getFileUpload = (req, res) => {
  res.render('image/upload', {
  title: 'File Upload',
  query: req.query
});
};

exports.handleSourceUrl = async (req, res, next) => {
  if (!req.file) {
    if (req.body.sourceUrl) {
      try {
        const file = getRandomFilename();
        await download(req.body.sourceUrl, "uploads/original/" + file);
        res.savedUrl = file;
        next();
      } catch (err){
        req.flash('errors', { msg: 'URL invalid.' });
        res.redirect('/image/single_upload');
      }
    } else {
      req.flash('errors', { msg: 'No File is given.' });
      res.redirect('/image/single_upload');
    }
  } else {
    next();
  }
};

function errorOnlyImages(){
  req.flash('errors', { msg: 'You can only upload images.' });
  res.redirect('/image/single_upload');
}

exports.postFileUpload = async (req, res, next) => {
  const wikidataId = req.body.wikidataEntityId;
  // console.log(req.body);
  if (!isEntityId(wikidataId)) {
    req.flash('errors', { msg: 'The Entity ID ' + wikidataId + ' is invalid.' });
    res.redirect('/image/single_upload');
  }
  const wikidataInfo = await getItem([wikidataId], 'en');
  const label = wdk.simplify.labels(wikidataInfo[wikidataId].labels).en;
  // const claims = wdk.simplify.claims(wikidataInfo[wikidataId].claim);

  // console.log(wikidataInfo);
  let imageDetails = {
    name: req.body.name,
    wikidataEntity: getNumericId(wikidataId),
    wikidataLabel: label,
    sourceUrl : req.body.sourceUrl,
    recordedDate: req.body.recordedDate,
    uploadSite: req.hostname,
    // wikidataType: label,
    viewCount: 0,
    createdBy: req.user,
  };
  if (req.file) {
    imageDetails.mimetype = req.file.mimetype;
    imageDetails.internalFileName = req.file.filename;
    imageDetails.originalFilename = req.file.originalname;
  } else {
    imageDetails.internalFileName = res.savedUrl;
    imageDetails.mimetype = 'image/jpeg';
  }

  const image = new Image(imageDetails);

  var savedImage = await image.save();

  fs.rename('uploads/original/' + imageDetails.internalFileName, 'uploads/original/' +savedImage.id, function (err) {
    if (err) throw err;
    console.log('Successfully renamed - AKA moved!')
  });

  createThumbnail(savedImage.id,imageDetails.mimetype);

  const wikidataLink = wdk.getSitelinkUrl({ site: 'wikidata', title: wikidataId });
  req.flash('success', { msg: `File was uploaded successfully. Photo of ${label} was saved and entered into the Database.` });
  res.redirect('/image/single_upload');
};
