'use strict'

const { Client } = require('@elastic/elasticsearch')
const cheerio = require('cheerio')
const fs = require('fs')
const Entities = require('html-entities').AllHtmlEntities
const entities = new Entities()
var debug = true;


async function getCredentials(client,key){
  var results = await client.security.createApiKey({
    refresh: 'true',
    body: key
  })
  console.error(restults)
}

var counter = 0 ;
async function filterAsciidocArticle($,page,client,indexname){
  
  var filterheadingsdebug = false ; 

  var results = [];
  var currentText = []

  const article = $('article.doc')
  const $h1 = $('h1', article)
  const documentTitle = $h1.first().text()

  var walkDOM = function (node,$,func) {
    func(node);
    node = node.firstChild;
    while(node) {
        walkDOM(node,$,func);
        node = node.nextSibling;
    }
  };    


  function updateResultsforHeading() {
    if (results.length) {
      if (!results[results.length - 1].text) {
  
        var text = entities.decode(currentText.join(""))
        // Strip HTML tags
        text = text.replace(/(<([^>]+)>)/ig, '')
          .replace(/\n/g, ' ')
          .replace(/\r/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
  
        results[results.length - 1].text = text
      }
    }
    currentText = []
  }

  $('nav.pagination', article).each(function () {
    $(this).remove()
  })
  $('.source-toolbox', article).each(function () {
    $(this).remove()
  })

  //invoke method after
  walkDOM(article[0],$, function(node) {
      
      if ( /^h[1-8]$/.test(node.tagName) && $(node).text() != "Contents"){
        // new chapter , clear text content 
        updateResultsforHeading()

        results.push ({
          id : $(node).attr("id"),
          tag : node.tagName,
          title : $(node).text(),
        })

        if (filterheadingsdebug){
          console.log("********************************");
          console.log("header : " + node.tagName +" "+ $(node).text());
          console.log($(node).attr("id"));
          console.log("********************************");
        }
      }

      ["paragraph","content","ulist"].forEach(function(item){
        if ( $(node).hasClass(item)){
          // console.log("Is a paragraph");
          if ( filterheadingsdebug ) console.log($(node).text())
          currentText.push($(node).text())
        }  
      })
      
  });
  updateResultsforHeading();
  
  // filter headings with no text 
  var newarray = results.filter(elt=>elt.text);


  for await (const item of newarray) {
    var hash = item.id ? '#' + item.id : '';
    try{
      var localres = await client.index({
        index: indexname,
          id: page.src.version + '@' + page.src.path + hash,
          body: {
            version: page.src.version,
            path: page.src.path,
            module: page.src.module,
            name: page.src.stem,
            // 
            title: documentTitle,
            subtitle: item.title,
            url: page.pub.url + hash,
            component: page.src.component,
            content: item.text },
        });
        // debug 
        // console.log(localres);
        // const print = [[page.src.version],[page.src.path],[page.src.module],[page.src.stem],[documentTitle],[item.title],[page.src.component],[JSON.stringify(localres)],[item.text]]
        // fs.writeFileSync(`c:\\${item.id}_${counter++}.txt`,print.join('\n'),'utf8'); 
      }
      catch(e){
        console.error(e);
      }
  }
}


async function indexSite (playbook, pages, contentCatalog,elasticurl,indexname,auth,env) {
  


  var connexionopts = !(auth && auth!="") ? {
    node: elasticurl,
    log : ['error','trace']
  } : {
    node: {
      log : ['error','trace'],
      url: new URL(elasticurl),
      auth: {
        apiKey: `${auth}`
      }
      // ssl: 'ssl options',
      // agent: 'http agent options',
      // id: 'custom node id',
      // headers: { 'custom': 'headers' },
      // roles: {
      //   master: true,
      //   data: true,
      //   ingest: true,
      //   ml: false
      // }
    }
  };

  var client
  var result
  try{
    if(debug) console.log(`Connecting to elasticsearch : ${JSON.stringify(connexionopts)}`)
    client = new Client(connexionopts)

    if(debug) console.log(`Deleting index ${indexname}`)
    result = await client.indices.delete({
      index: indexname,
      ignore_unavailable: true,
    })
    if(debug) console.dir(result)
  }
  catch(e){
    console.error(e);
  }

  function getMultiDef (name,boost) {
    var def = {
      type: 'text',
      fields: {
        raw: {
          type: 'keyword',
        },
      },
    }

    if ( boost) def = Object.assign(def,{boost : boost})

    return def
  }

  try {
    if(debug) console.log(`Creating index ${indexname}`)
    result = await client.indices.create({
      index: indexname,
      body: {
        settings: {
          index: {
            analysis: {
              //analyzer: {
              char_filter: {
                replace: {
                  type: 'mapping',
                  mappings: [
                    '&=> and ',
                  ],
                },
              },
              filter: {
                word_delimiter: {
                  type: 'word_delimiter',
                  split_on_numerics: false,
                  split_on_case_change: true,
                  generate_word_parts: true,
                  generate_number_parts: true,
                  catenate_all: true,
                  preserve_original: true,
                  catenate_numbers: true,
                },
              },
              analyzer: {
                default: {
                  type: 'custom',
                  char_filter: [
                    'html_strip',
                    'replace',
                  ],
                  tokenizer: 'whitespace',
                  filter: [
                    'lowercase',
                    'word_delimiter',
                  ],
                },
              },
              //},
            },
          },
        },
        mappings: {
          properties: {
            version: getMultiDef('version'),
            module: getMultiDef('module'),
            component: getMultiDef('component'),
          },
        },
      },
    })
    if(debug) console.dir(result)
  } catch (err) {
    console.error(err)
    console.error(err.body.error)
    return
  }


  let siteUrl = playbook.site.url
  if (!siteUrl) {
    // Uses relative links when site URL is not set
    siteUrl = ''
  }
  if (siteUrl.charAt(siteUrl.length - 1) === '/') siteUrl = siteUrl.substr(0, siteUrl.length - 1)
  if (!pages.length) return {}
  // Map of Lunr ref to document
  const documentsStore = {}
  const documents = pages
    .map((page) => {
      const html = page.contents.toString()
      const $ = cheerio.load(html)
      return { page, $ }
    })
    // Exclude pages marked as "noindex"
    .filter(({ page, $ }) => {
      const $metaRobots = $('meta[name=robots]')

      const metaRobotNoIndex = $metaRobots && $metaRobots.attr('content') === 'noindex'
      const pageNoIndex = page.asciidoc && page.asciidoc.attributes && page.asciidoc.attributes.noindex === ''
      const noIndex = metaRobotNoIndex || pageNoIndex
      const indexOnlyLatest = env.DOCSEARCH_INDEX_VERSION &&
                              env.DOCSEARCH_INDEX_VERSION === 'latest'
      if (indexOnlyLatest) {
        const component = contentCatalog.getComponent(page.src.component)
        const thisVersion = contentCatalog.getComponentVersion(component, page.src.version)
        const latestVersion = contentCatalog.getComponent(page.src.component).latest
        const notLatest = thisVersion !== latestVersion
        return !(noIndex || notLatest)
      }
      return !noIndex
    })
    .map( async ({ page, $ }) => {

      await filterAsciidocArticle($,page,client,indexname);

      // // Fetch just the article content, so we don't index the TOC and other on-page text
      // // Remove any found headings, to improve search results
      // const article = $('article.doc')
      // const $h1 = $('h1', article)
      // const documentTitle = $h1.first().text()
      // $h1.remove()
      // const titles = []
      // $('h2,h3,h4,h5,h6', article).each(function () {
      //   const $title = $(this)
      //   // If the title does not have an Id then Lunr will throw a TypeError
      //   // cannot read property 'text' of undefined.
      //   if ($title.attr('id')) {
      //     titles.push({
      //       text: $title.text(),
      //       id: $title.attr('id')
      //     })
      //   }
      //   $title.remove()
      // })

      // // don't index navigation elements for pagination on each page
      // // as these are the titles of other pages and it would otherwise pollute the index.
      // $('nav.pagination', article).each(function () {
      //   $(this).remove()
      // })


      // // Pull the text from the article, and convert entities
      // let text = article.text()
      // // Decode HTML
      // text = entities.decode(text)
      // // Strip HTML tags
      // text = text.replace(/(<([^>]+)>)/ig, '')
      //   .replace(/\n/g, ' ')
      //   .replace(/\r/g, ' ')
      //   .replace(/\s+/g, ' ')
      //   .trim()
        
      //     await client.index({
      //     index: indexname,
      //       id: page.src.version + '@' + page.src.path,
      //       type: '_doc',
      //       body: {
      //         version: page.src.version,
      //         path: page.src.path,
      //         module: page.src.module,
      //         name: page.src.stem,
      //         title: documentTitle,
      //         titles: titles,
      //         url: page.pub.url,
      //         component: page.src.component,
      //         content: text },
      //     });
      })
    
      // try{
      //   client.index(doc);
      //   // documents.forEach(function (doc) {
      //     // async (doc) => {
      //     //   result = await client.index(doc);
      //     // }
      //   // });
      // }
      // catch(e){
      //   console.error(e)
      // }



  // var index = 0 ;
  // for (let page of pages) {

  //   // console.log(page.src.path + '@' + page.src.version)
  //   // promise API
  //   var article = cheerio.load(page.contents)('article')
  //   var extractContent = article.text()
  //   var documentTitle = article.find('h1').text()

  //   // fs.writeFileSync(`c:\\${index++}.txt`,extractContent,'utf8'); 
  //   // fs.writeFileSync(`c:\\${index++}.txt`,page.pub.url,'utf8'); 
  //   try{
  //     result = await client.index({
  //       index: indexname,
  //       id: page.src.version + '@' + page.src.path,
  //       type: '_doc',
  //       body: {
  //         version: page.src.version,
  //         path: page.src.path,
  //         module: page.src.module,
  //         name: page.src.stem,
  //         title: documentTitle,
  //         url: page.pub.url,
  //         component: page.src.component,
  //         content: extractContent },
  //     })
  //   }
  //   catch(e){
  //     console.error(e)
  //   }

    // console.log(result)
  // }
}

process.on('unhandledRejection', function(err) {
  console.error(err);
});

module.exports = indexSite