import json
import subprocess
import datetime

def call_mcp(command):
    result = subprocess.run(command, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        raise Exception(f"MCP command failed: {result.stderr}")
    try:
        # MCP tool call output format is 'Tool execution result saved to: ...\nTool execution result:\n{json_output}\n'
        json_start = result.stdout.find("Tool execution result:\n")
        if json_start != -1:
            json_str = result.stdout[json_start + len("Tool execution result:\n"):].strip()
            return json.loads(json_str)
        else:
            raise Exception(f"Could not find JSON in MCP output: {result.stdout}")
    except json.JSONDecodeError as e:
        raise Exception(f"Failed to decode JSON from MCP output: {e}\nOutput: {result.stdout}")

def end_tenancy(tenancy_record_id: str, end_date: str):
    base_id = "appnqjDpqDniH3IRl"

    # Table and Field IDs
    tenancies_table_id = "tblN51a88qTDB6iMH"
    tenancy_end_date_field_id = "fldwHhhKAq4f1nY9e"
    tenancy_payment_status_field_id = "fldxU3dPUnbK0SCDq" # Payment Status (Unified) - cleared on tenancy end
    tenancy_tenant_link_field_id = "fld1i5bDoHL3B6rUf" # Link to Tenants table
    tenancy_rental_unit_link_field_id = "fld7cjLLEHKAx49OK" # Link to Rental Units table

    tenants_table_id = "tblX4elTuu01gwBYh"
    tenant_status_field_id = "fldAXzP9SGIHiAhrv"
    tenant_current_unit_field_id = "fldeLsZYqbKS77S2V"
    tenant_status_former_choice_id = "sely5PbQQqgfAdJGL"

    rental_units_table_id = "tblM3mZCR5kiEdWMj"
    rental_unit_status_field_id = "fldBvqysXBm9rIm0E"
    rental_unit_status_void_choice_id = "selozSwvOmOLRQNNM"

    # 1. Get linked Tenant and Rental Unit IDs from the Tenancy record
    print(f"Fetching Tenancy record {tenancy_record_id} to get linked Tenant and Rental Unit IDs...")
    tenancy_record = call_mcp(f"manus-mcp-cli tool call get_record --server airtable --input '{{\"baseId\": \"{base_id}\", \"tableId\": \"{tenancies_table_id}\", \"recordId\": \"{tenancy_record_id}\"}}'")

    tenant_record_id = None
    if tenancy_tenant_link_field_id in tenancy_record["fields"] and tenancy_record["fields"][tenancy_tenant_link_field_id]:
        tenant_record_id = tenancy_record["fields"][tenancy_tenant_link_field_id][0]["id"]
        print(f"Linked Tenant Record ID: {tenant_record_id}")
    else:
        print("No linked tenant found for this tenancy.")

    rental_unit_record_id = None
    if tenancy_rental_unit_link_field_id in tenancy_record["fields"] and tenancy_record["fields"][tenancy_rental_unit_link_field_id]:
        rental_unit_record_id = tenancy_record["fields"][tenancy_rental_unit_link_field_id][0]["id"]
        print(f"Linked Rental Unit Record ID: {rental_unit_record_id}")
    else:
        print("No linked rental unit found for this tenancy.")

    # 2. Update Tenancy record: Set Tenancy End Date and clear Payment Status (Unified)
    print(f"Updating Tenancy record {tenancy_record_id} with End Date: {end_date} and clearing Payment Status...")
    tenancy_update_data = {
        "fields": {
            tenancy_end_date_field_id: end_date,
            tenancy_payment_status_field_id: None  # Clear Payment Status (Unified) on tenancy end
        }
    }
    call_mcp(f"manus-mcp-cli tool call update_record --server airtable --input '{{\"baseId\": \"{base_id}\", \"tableId\": \"{tenancies_table_id}\", \"recordId\": \"{tenancy_record_id}\", \"recordData\": {json.dumps(tenancy_update_data)}}}'")
    print("Tenancy record updated successfully.")

    # 3. Update Tenant record: Change Tenant Status to 'Former' and clear 'Current Unit'
    if tenant_record_id:
        print(f"Updating Tenant record {tenant_record_id}...")
        tenant_update_data = {
            "fields": {
                tenant_status_field_id: {"id": tenant_status_former_choice_id},
                tenant_current_unit_field_id: [] # Clear the link
            }
        }
        call_mcp(f"manus-mcp-cli tool call update_record --server airtable --input '{{\"baseId\": \"{base_id}\", \"tableId\": \"{tenants_table_id}\", \"recordId\": \"{tenant_record_id}\", \"recordData\": {json.dumps(tenant_update_data)}}}'")
        print("Tenant record updated successfully.")
    else:
        print("Skipping Tenant update as no linked tenant was found.")

    # 4. Update Rental Unit record: Change Unit Status to 'Void'
    if rental_unit_record_id:
        print(f"Updating Rental Unit record {rental_unit_record_id}...")
        rental_unit_update_data = {
            "fields": {
                rental_unit_status_field_id: {"id": rental_unit_status_void_choice_id}
            }
        }
        call_mcp(f"manus-mcp-cli tool call update_record --server airtable --input '{{\"baseId\": \"{base_id}\", \"tableId\": \"{rental_units_table_id}\", \"recordId\": \"{rental_unit_record_id}\", \"recordData\": {json.dumps(rental_unit_update_data)}}}'")
        print("Rental Unit record updated successfully.")
    else:
        print("Skipping Rental Unit update as no linked rental unit was found.")

    print("Tenancy ending process completed.")

if __name__ == "__main__":
    import sys
    if len(sys.argv) != 3:
        print("Usage: python end_tenancy.py <tenancy_record_id> <end_date_YYYY-MM-DD>")
        sys.exit(1)

    tenancy_record_id = sys.argv[1]
    end_date = sys.argv[2]

    # Basic date validation
    try:
        datetime.datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError:
        print("Error: Invalid date format. Please use YYYY-MM-DD.")
        sys.exit(1)

    end_tenancy(tenancy_record_id, end_date)
