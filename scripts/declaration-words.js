// The words that make a form question a declaration (claims, convictions, CCJs, bankruptcy, refused
// or cancelled insurance, charges, insolvency). Shared by agent-browser.js, which hands any page that
// asks one to Kevin whole, and form-facts.js, which never stores one as a fact: declarations live in
// his standing answers file under his own ruling. One copy, so the two can never drift apart.
const DECLARATION_TOPIC_RE = /\b(claims?|convict\w*|criminal|offences?|ccjs?|county court|judge?ments?|bankrupt\w*|refused|cancell?ed|voided|declined|special terms|terms imposed|imposed|charged?|prosecut\w*|investigat\w*|police|cautions?|insolven\w*|liquidat\w*|disqualif\w*|struck off|strike off|material facts?|iva|individual voluntary|debt relief|sequestrat\w*|arrangements? with (?:your |their |its )?creditors|administration|administrators?|receivership)\b/i;
// A first-person declaration, or words that sit beside one ("I confirm that", "true and correct").
const NEARBY_DECLARATION_RE = /\b(i|we) (declare|confirm|agree|accept|understand|have read)\b|\bdeclar(e|ation)\b|\bconfirm that\b|\bagree (to|with)\b|\baccept the\b|\btrue and (correct|accurate|complete)\b|\bstatement of fact\b/i;
// A question the robot never answers, whatever his covers say: crime, insolvency, motoring, "anything
// else", material facts (agent-browser.js, estate fix 3).
const NEVER_ROBOT_RE = /\b(convict\w*|criminal|offen[cs]es?|charg(?:e|ed|es|ing)|prosecut\w*|investigat\w*|police|cautions?|insolven\w*|liquidat\w*|iva|individual voluntary arrangements?|debt relief|sequestrat\w*|arrangements? with (?:\w+ )?creditors|administrat(?:ion|ors?)|receiver\w*|disqualif\w*|struck off|strike off|motoring|anything else|material facts?)\b/i;
// Forms round 2 (15 Nov 2026): a question whose answer is a private value, never recorded from his window
// (agent-browser.js capture, form-facts.js addCaptured): card and bank details, passwords and codes, identity
// numbers, and anything about verifying who he is (widened by review R1).
const PRIVATE_QUESTION_RE = /\b(card|cvv|cvc|security code|sort code|account (number|no)|iban|expiry|password|passcode|pin|national insurance|passport|driving licen[cs]e|mother'?s maiden|memorable|bank|account holder|holder name|roll number|building society|verification|verify|security question|sent to your (?:phone|mobile|email)|one[- ]time|otp|authenticat\w*)\b|\b\d[- ]digit\b/i;
// Losses and disputes (review R1): never declaration topics for the facts file, but a page that mentions one is
// never recorded from, in case its question is a declaration the topic list misses. Capture only.
const CAPTURE_LOSS_RE = /\b(loss(?:es)?|damage|theft|stolen|fire|flood\w*|subsid\w*|heave|landslip|incident|accident|dispute|arrears|evict\w*)\b/i;

module.exports = { DECLARATION_TOPIC_RE, NEARBY_DECLARATION_RE, NEVER_ROBOT_RE, PRIVATE_QUESTION_RE, CAPTURE_LOSS_RE };
