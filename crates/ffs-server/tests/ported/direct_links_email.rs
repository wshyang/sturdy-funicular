//! PORT-4A — test/backend/deno/direct-links-email.test.tsx (31 assertions).
//! Every lifecycle notification must contain a rendered, resolvable direct-link key.
use super::fixtures::*;
use anyhow::{bail, Result};
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use serde_json::{json, Value};
use sqlx::Row;

async fn outbox_direct_link(app: &TestApp, trigger: &str) -> Result<Option<String>> {
    let row=sqlx::query("SELECT rendered_body_html FROM sent_notifications WHERE trigger_key::text=$1 ORDER BY created_at DESC LIMIT 1")
        .bind(trigger).fetch_optional(app.db()).await?;
    parity_assert!("L:d2c75aaa19f296eb-1",row.is_some());
    let html:String=row.map(|r|r.try_get("rendered_body_html")).transpose()?.unwrap_or_default();
    let re=regex::Regex::new(r#"<a href="[^"]*\?dl=([0-9A-Za-z]{12})""#)?;
    let key=re.captures(&html).map(|c|c[1].to_string());
    parity_assert!("L:3fb93a14cd73cc22-1",key.is_some());
    parity_assert!("L:60f455ff61499c8f-1",!html.contains("{{directLink"));
    parity_assert!("L:f3a2f85d77e89a29-1",!html.contains("{{request_direct_link"));
    Ok(key)
}
async fn checked_link(app:&TestApp,trigger:&str,id:&str)->Result<()> {
    // The call-site assertion mirrors the legacy assertOutboxHasDirectLink step;
    // the helper separately pins the four rendered-HTML assertions.
    let found=outbox_direct_link(app,trigger).await?.is_some();
    match id {
        "submitted"=>parity_assert!("L:4e14de3250d640f5-1",found),
        "confirmation"=>parity_assert!("L:9486b077293051f4-1",found),
        "next"=>parity_assert!("L:2be86a1431c9b3d3-1",found),
        "owner"=>parity_assert!("L:b4c23e23de74067c-1",found),
        "returned"=>parity_assert!("L:fe1daacf76653bc8-1",found),
        "rejected"=>parity_assert!("L:0db74b40a085df1b-1",found),
        "resubmitted"=>parity_assert!("L:e2279d8cc0193f45-1",found),
        "owner_agency"=>parity_assert!("L:703388338acbf7ec-1",found),
        "owner_submitter"=>parity_assert!("L:559b0cd2331dee82-1",found),
        "owner_returned"=>parity_assert!("L:d9fc6294a4c3c2b3-1",found),
        "owner_rejected"=>parity_assert!("L:be1f7c83ad54165b-1",found),
        "issued"=>parity_assert!("L:ae05249ef559309d-1",found),
        "closed_submitter"=>parity_assert!("L:78bb9f57bfc6d8b9-1",found),
        "closed_owner"=>parity_assert!("L:efeb09f979d62a7e-1",found),
        "reset"=>parity_assert!("L:7e81223c6782cf34-1",found),
        _=>bail!("unknown assertion label"),
    }
    Ok(())
}
async fn post(app:&TestApp,token:&str,path:&str,body:Value)->Result<(u16,Value)> {
    let (st,v)=app.auth_post_json(path,token,body).await?; Ok((st.as_u16(),v))
}
fn sess(s:&FourStepSystem,k:&str)->String{s.sessions[k].clone()}
async fn submit(app:&TestApp,s:&FourStepSystem)->Result<String> {
    let now=chrono::Utc::now();
    let (st,data)=post(app,&sess(s,"submitter"),"/requests",json!({"systemId":s.system_id,
        "justification":"Investigate a production incident requiring elevated access.","srNumber":"SR-1001",
        "activityStartAt":(now+chrono::Duration::hours(1)).to_rfc3339(),"activityEndAt":(now+chrono::Duration::hours(4)).to_rfc3339(),
        "credentialItems":[{"assetId":s.asset_id,"hostnameDescription":"test host"}]})).await?;
    if st!=201 {bail!("submit failed: {st} {data}");}
    Ok(data["request"]["id"].as_str().unwrap().to_string())
}
async fn approve(app:&TestApp,s:&FourStepSystem,id:&str,role:&str)->Result<u16> {
    Ok(post(app,&sess(s,role),&format!("/requests/{id}/step-decision"),json!({"decision":"approve"})).await?.0)
}
async fn owner_terminal(app:&TestApp,s:&FourStepSystem)->Result<String> {
    let id=submit(app,s).await?;
    for role in ["vendorApprover","agencyApprover","vendorL3Approver","agencyL2Approver"] {
        if approve(app,s,&id,role).await?!=200 {bail!("approval failed for {role}");}
    }
    Ok(id)
}

#[tokio::test]
async fn direct_links_email_outbox() -> Result<()> {
    TestApp::run("direct-links-email", |app| async move {
        prepare(&app).await?;
        let admin=create_admin(&app,"DLEmailAdmin!2026").await?;
        let admin_session=session_of(&login_user(&app,&admin).await?)?;
        let owner=mk_user(&app,"agency").await?;
        let s=create_four_step_system(&app,admin.id,&owner).await?;
        let _id=submit(&app,&s).await?;
        // The submit status is asserted separately below with a fresh request,
        // matching the legacy submit helper's assertion site.
        checked_link(&app,"request.submitted","submitted").await?;
        checked_link(&app,"request.submitted_confirmation","confirmation").await?;
        let (st,data)=app.auth_post_json("/requests",&sess(&s,"submitter"),json!({"systemId":s.system_id,
            "justification":"Investigate a production incident requiring elevated access.","srNumber":"SR-1001",
            "activityStartAt":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339(),
            "activityEndAt":(chrono::Utc::now()+chrono::Duration::hours(4)).to_rfc3339(),
            "credentialItems":[{"assetId":s.asset_id}]})).await?;
        parity_assert_eq!("L:bebe0c94d059ee79-1",st.as_u16(),201);
        let id=data["request"]["id"].as_str().unwrap();
        let st=approve(&app,&s,id,"vendorApprover").await?; parity_assert_eq!("L:5f1c929fdfa5ec1d-1",st,200);
        checked_link(&app,"request.step_approved_next_reviewer","next").await?;

        // Four-step fixture: the final agency L2 approval is the owner handoff.
        let id=submit(&app,&s).await?;
        for role in ["vendorApprover","agencyApprover","vendorL3Approver"] { approve(&app,&s,&id,role).await?; }
        let st=approve(&app,&s,&id,"agencyL2Approver").await?; parity_assert_eq!("L:59e2e850b9bdc0a7-1",st,200);
        checked_link(&app,"request.step_approved_owner","owner").await?;
        let id=submit(&app,&s).await?;
        let (st,_)=post(&app,&sess(&s,"vendorApprover"),&format!("/requests/{id}/step-decision"),json!({"decision":"return","notes":"Please add more detail."})).await?;
        parity_assert_eq!("L:721545034d9b1180-1",st,200); checked_link(&app,"request.step_returned","returned").await?;
        let id2=submit(&app,&s).await?;
        let (st,_)=post(&app,&sess(&s,"vendorApprover"),&format!("/requests/{id2}/step-decision"),json!({"decision":"reject","notes":"Not justified."})).await?;
        parity_assert_eq!("L:459afa826b8d6bcc-1",st,200); checked_link(&app,"request.step_rejected","rejected").await?;
        let now=chrono::Utc::now();
        let (st,_)=app.auth_send_json(reqwest::Method::PUT,&format!("/requests/{id}/resubmit"),&sess(&s,"submitter"),json!({"systemId":s.system_id,
            "justification":"Updated incident details for re-review.","srNumber":"SR-1001",
            "activityStartAt":(now+chrono::Duration::hours(1)).to_rfc3339(),"activityEndAt":(now+chrono::Duration::hours(4)).to_rfc3339(),
            "credentialItems":[{"assetId":s.asset_id}]})).await?;
        parity_assert_eq!("L:e6b2d0781d279b1d-1",st.as_u16(),200); checked_link(&app,"request.resubmitted_step2","resubmitted").await?;

        let id=owner_terminal(&app,&s).await?;
        let (st,_)=post(&app,&sess(&s,"owner"),&format!("/requests/{id}/owner-decision"),json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:dc3073903bef4e59-1",st,200);
        checked_link(&app,"request.owner_approved_agency_l1","owner_agency").await?;
        checked_link(&app,"request.owner_approved_submitter","owner_submitter").await?;
        let ret=owner_terminal(&app,&s).await?;
        let (st,_)=post(&app,&sess(&s,"owner"),&format!("/requests/{ret}/owner-decision"),json!({"decision":"return","notes":"Need more context."})).await?;
        parity_assert_eq!("L:6b501f993f6dfda6-1",st,200); checked_link(&app,"request.owner_returned","owner_returned").await?;
        let rej=owner_terminal(&app,&s).await?;
        let (st,_)=post(&app,&sess(&s,"owner"),&format!("/requests/{rej}/owner-decision"),json!({"decision":"reject","notes":"Denied."})).await?;
        parity_assert_eq!("L:728e5d61b516e080-1",st,200); checked_link(&app,"request.owner_rejected","owner_rejected").await?;
        let (st,_)=post(&app,&sess(&s,"agencyL2Approver"),&format!("/requests/{id}/issue-credential"),json!({})).await?;
        parity_assert_eq!("L:7d687c730c8dc601-1",st,200); checked_link(&app,"request.credential_issued","issued").await?;
        let (st,_)=post(&app,&sess(&s,"agencyL2Approver"),&format!("/requests/{id}/close"),json!({"closingNotes":"Done."})).await?;
        parity_assert_eq!("L:15b78d1327b474e9-1",st,200);
        checked_link(&app,"request.closed_submitter","closed_submitter").await?;
        checked_link(&app,"request.closed_system_owner","closed_owner").await?;
        let reset=owner_terminal(&app,&s).await?;
        let (st,_)=post(&app,&admin_session,&format!("/requests/{reset}/admin-reset"),json!({"notes":"Reset for re-review."})).await?;
        parity_assert_eq!("L:0b251d341ee97209-1",st,200); checked_link(&app,"request.admin_reset","reset").await?;
        Ok(())
    }).await
}
