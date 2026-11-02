// Workers Builds injects a target name/tag for its connected navigation Worker.
// A separately authorized mailbox deployment must keep its own configured target.
export function deploymentEnvironment(source,account,token,mailTarget=false){
 const env={...source,CI:'true',WRANGLER_SEND_METRICS:'false',CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:token};
 if(mailTarget){delete env.WRANGLER_CI_OVERRIDE_NAME;delete env.WRANGLER_CI_MATCH_TAG;}
 return env;
}
