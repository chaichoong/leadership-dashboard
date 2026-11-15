// The words that make a form question a declaration (claims, convictions, CCJs, bankruptcy, refused
// or cancelled insurance, charges, insolvency). Shared by agent-browser.js, which hands any page that
// asks one to Kevin whole, and form-facts.js, which never stores one as a fact: declarations live in
// his standing answers file under his own ruling. One copy, so the two can never drift apart.
const DECLARATION_TOPIC_RE = /\b(claims?|convict\w*|criminal|offences?|ccjs?|county court|judge?ments?|bankrupt\w*|refused|cancell?ed|voided|declined|special terms|terms imposed|imposed|charged?|prosecut\w*|investigat\w*|police|cautions?|insolven\w*|liquidat\w*|disqualif\w*|struck off|strike off|material facts?|iva|individual voluntary|debt relief|sequestrat\w*|arrangements? with (?:your |their |its )?creditors|administration|administrators?|receivership)\b/i;

module.exports = { DECLARATION_TOPIC_RE };
